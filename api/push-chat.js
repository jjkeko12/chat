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
  if (!body) return res.status(400).json({ error: 'Falta el mensaje' });

  // Todas las suscripciones, menos las de quien escribió el mensaje
  let q = c.db.from('push_subscriptions').select('endpoint, p256dh, auth, user_id');
  if (user_id) q = q.neq('user_id', user_id);
  const { data: subs, error } = await q;
  if (error) return res.status(500).json({ error: 'Supabase: ' + error.message });

  const texto = body.length > 140 ? body.slice(0, 137) + '…' : body;
  const payload = JSON.stringify({
    title: '💬 Chat de amigos',
    body: kind === 'me' ? '* ' + author + ' ' + texto : author + ': ' + texto,
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
