const REQUERIDAS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WEBHOOK_SECRET'];

let ctx = null;

// Todo se inicia aquí dentro para poder explicar qué falla en vez de caerse sin mensaje
async function init() {
  if (ctx) return ctx;
  const webpush = (await import('web-push')).default;
  const { createClient } = await import('@supabase/supabase-js');
  webpush.setVapidDetails(
    'https://vercel.com/', // "subject" genérico exigido por el estándar
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  // .origin recorta cualquier cosa extra que se haya pegado (/rest/v1, diagonales, etc.)
  ctx = { webpush, db: createClient(new URL(process.env.SUPABASE_URL).origin, process.env.SUPABASE_SERVICE_KEY) };
  return ctx;
}

export default async function handler(req, res) {
  const faltan = REQUERIDAS.filter((k) => !process.env[k]);

  // Abrir esta dirección en el navegador sirve de diagnóstico (no muestra ningún valor secreto)
  if (req.method !== 'POST') {
    let errorDeConfiguracion = null;
    if (faltan.length === 0) {
      try { await init(); } catch (e) { errorDeConfiguracion = e.message; }
    }
    return res.status(200).json({
      mensaje: 'La función existe. Los avisos llegan por POST.',
      variablesQueFaltan: faltan,
      errorDeConfiguracion,
    });
  }

  if (faltan.length) return res.status(500).json({ error: 'Faltan variables en Vercel', faltan });

  // Solo acepta avisos que vengan de tu base de datos (comparten este secreto)
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let c;
  try { c = await init(); } catch (e) { return res.status(500).json({ error: 'Configuración inválida: ' + e.message }); }

  const { author, body, kind, user_id } = req.body || {};
  if (!body || !user_id) return res.status(400).json({ error: 'Faltan datos del mensaje' });

  // Busca a qué sala pertenece el mensaje, para avisar solo a quienes están en ella
  const { data: msg } = await c.db.from('messages').select('room_id').eq('user_id', user_id).eq('body', body)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!msg) return res.status(200).json({ ok: true, enviados: 0, aviso: 'No encontré el mensaje' });
  const { data: room } = await c.db.from('rooms').select('kind, name').eq('id', msg.room_id).single();
  if (!room) return res.status(200).json({ ok: true, enviados: 0, aviso: 'No encontré la sala' });

  let q = c.db.from('push_subscriptions').select('endpoint, p256dh, auth, user_id').neq('user_id', user_id);
  if (room.kind !== 'general') {
    const { data: ms } = await c.db.from('room_members').select('user_id').eq('room_id', msg.room_id);
    const ids = (ms || []).map((m) => m.user_id);
    if (!ids.length) return res.status(200).json({ ok: true, enviados: 0 });
    q = q.in('user_id', ids);
  }
  const { data: subs, error } = await q;
  if (error) return res.status(500).json({ error: 'Supabase: ' + error.message });

  const texto = body.length > 140 ? body.slice(0, 137) + '…' : body;
  const cuerpo = kind === 'me' ? '* ' + author + ' ' + texto : room.kind === 'dm' ? texto : author + ': ' + texto;
  const payload = JSON.stringify({
    title: room.kind === 'group' ? '👥 ' + room.name : room.kind === 'dm' ? '💬 ' + author : '💬 Chat de amigos',
    body: cuerpo,
    tag: msg.room_id,
  });

  const results = await Promise.allSettled(
    subs.map((s) =>
      c.webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
    )
  );

  // Borra las suscripciones que ya no existen (navegador desinstalado, permiso quitado, etc.)
  const muertas = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && [404, 410].includes(r.reason && r.reason.statusCode)) {
      muertas.push(subs[i].endpoint);
    }
  });
  if (muertas.length) await c.db.from('push_subscriptions').delete().in('endpoint', muertas);

  const fallidos = results.filter((r) => r.status === 'rejected').length;
  // Motivo de cada fallo (aparece en net._http_response)
  const detalles = results
    .filter((r) => r.status === 'rejected')
    .map((r) => ({
      statusCode: r.reason && r.reason.statusCode,
      mensaje: String((r.reason && (r.reason.body || r.reason.message)) || '').slice(0, 100),
    }));
  return res.status(200).json({ ok: true, enviados: results.length - fallidos, fallidos, detalles });
}
