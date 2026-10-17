import { createECDH } from 'crypto';

const REQUERIDAS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];

// ¿La clave de Supabase es la secreta (correcta) o la pública (incorrecta)?
function tipoDeClave(k) {
  if (k.startsWith('sb_secret_')) return 'ok';
  if (k.startsWith('sb_publishable_')) return 'publishable';
  try {
    const role = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role;
    return role === 'service_role' ? 'ok' : (role || 'desconocida');
  } catch (e) { return 'desconocida'; }
}

// ¿La clave pública y la privada de VAPID son un par?
function esPar(pub, priv) {
  try {
    const e = createECDH('prime256v1');
    e.setPrivateKey(Buffer.from(priv, 'base64url'));
    return e.getPublicKey().toString('base64url') === pub;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const faltan = REQUERIDAS.filter((k) => !process.env[k]);
  if (faltan.length) return res.status(500).json({ error: 'Faltan variables en Vercel: ' + faltan.join(', ') });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });

  let webpush, db;
  try {
    webpush = (await import('web-push')).default;
    const { createClient } = await import('@supabase/supabase-js');
    webpush.setVapidDetails('https://vercel.com/', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    db = createClient(new URL(process.env.SUPABASE_URL).origin, process.env.SUPABASE_SERVICE_KEY);
  } catch (e) {
    return res.status(500).json({ error: 'Configuración inválida: ' + e.message });
  }

  const { data: u, error: ue } = await db.auth.getUser(token);
  if (ue || !u || !u.user) return res.status(401).json({ error: 'Sesión no válida: vuelve a entrar al chat' });

  // Revisiones de configuración que explican la mayoría de los fallos
  const advertencias = [];
  const tipo = tipoDeClave(process.env.SUPABASE_SERVICE_KEY);
  if (tipo !== 'ok') {
    advertencias.push('SUPABASE_SERVICE_KEY no parece la clave secreta (' + tipo + '): usa la service_role / secret key, no la pública.');
  }
  if (!esPar(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)) {
    advertencias.push('VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY de Vercel no son un par: genéralas juntas con generar-vapid.html.');
  }
  const clave = req.body && req.body.clave;
  if (clave && clave !== process.env.VAPID_PUBLIC_KEY) {
    advertencias.push('La clave pública de index.html no coincide con VAPID_PUBLIC_KEY de Vercel. Corrígela, sube index.html y en el menú pulsa Desactivar y luego Activar.');
  }

  const { data: subs, error } = await db.from('push_subscriptions')
    .select('endpoint, p256dh, auth').eq('user_id', u.user.id);
  if (error) return res.status(500).json({ error: 'Supabase: ' + error.message });
  if (!subs.length) {
    return res.status(200).json({
      dispositivos: 0,
      aviso: 'Esta cuenta no tiene dispositivos registrados. Pulsa Desactivar y luego Activar notificaciones.',
      advertencias,
    });
  }

  const payload = JSON.stringify({ title: '💬 Chat de amigos', body: 'Notificación de prueba ✅', test: true });
  const results = await Promise.allSettled(
    subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload))
  );

  const detalles = [];
  const muertas = [];
  results.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    const code = r.reason && r.reason.statusCode;
    detalles.push({ statusCode: code, mensaje: String((r.reason && (r.reason.body || r.reason.message)) || '').slice(0, 120) });
    if (code === 404 || code === 410) muertas.push(subs[i].endpoint);
  });
  if (muertas.length) await db.from('push_subscriptions').delete().in('endpoint', muertas);

  return res.status(200).json({
    dispositivos: subs.length,
    enviados: results.length - detalles.length,
    fallidos: detalles.length,
    detalles,
    advertencias,
  });
}
