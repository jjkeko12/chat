import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

webpush.setVapidDetails(
  'https://vercel.com/', // "subject" genérico exigido por el estándar
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Solo acepta avisos que vengan de tu base de datos (comparten este secreto)
  if (!process.env.WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { author, body, kind, user_id } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Falta el mensaje' });

  // Todas las suscripciones, menos las de quien escribió el mensaje
  let q = db.from('push_subscriptions').select('endpoint, p256dh, auth, user_id');
  if (user_id) q = q.neq('user_id', user_id);
  const { data: subs, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const texto = body.length > 140 ? body.slice(0, 137) + '…' : body;
  const payload = JSON.stringify({
    title: '💬 Chat de amigos',
    body: kind === 'me' ? '* ' + author + ' ' + texto : author + ': ' + texto,
  });

  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
    )
  );

  // Borra las suscripciones que ya no existen (navegador desinstalado, permiso quitado, etc.)
  const muertas = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && [404, 410].includes(r.reason && r.reason.statusCode)) {
      muertas.push(subs[i].endpoint);
    }
  });
  if (muertas.length) await db.from('push_subscriptions').delete().in('endpoint', muertas);

  const fallidos = results.filter((r) => r.status === 'rejected').length;
  return res.status(200).json({ ok: true, enviados: results.length - fallidos, fallidos });
}
