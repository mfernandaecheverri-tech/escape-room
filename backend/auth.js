const crypto = require('crypto');

const DURACION_SESION_S = 12 * 3600;
let SECRETO = process.env.SESSION_SECRET;
if (!SECRETO) {
  SECRETO = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  SESSION_SECRET no está definido: se usa una clave temporal. Las sesiones se perderán cada vez que el servidor se reinicie. Defínela en Render.');
}

// ------------------------------------------------------------ sesiones propias
function firmarSesion(uid) {
  const cuerpo = Buffer.from(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + DURACION_SESION_S })).toString('base64url');
  const firma = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

function verificarSesion(token) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const esperada = crypto.createHmac('sha256', SECRETO).update(partes[0]).digest();
  const recibida = Buffer.from(partes[1], 'base64url');
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
  try {
    const datos = JSON.parse(Buffer.from(partes[0], 'base64url').toString());
    if (!datos.uid || !datos.exp || datos.exp <= Math.floor(Date.now() / 1000)) return null;
    return datos;
  } catch (e) { return null; }
}

// ------------------------------------------------------------ verificación del ID token de Google
let cacheLlaves = { claves: null, hasta: 0 };

async function obtenerLlavesGoogle(forzar) {
  if (!forzar && cacheLlaves.claves && Date.now() < cacheLlaves.hasta) return cacheLlaves.claves;
  const url = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
  const r = await fetch(url);
  if (!r.ok) throw new Error('No se pudieron obtener las llaves públicas de Google');
  const json = await r.json();
  const cc = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  const ttl = Math.min(Math.max(Number(cc ? cc[1] : 3600), 60), 24 * 3600) * 1000;
  cacheLlaves = { claves: json.keys || [], hasta: Date.now() + ttl };
  return cacheLlaves.claves;
}

async function verificarGoogle(credencial, clientId) {
  if (typeof credencial !== 'string' || credencial.split('.').length !== 3) throw new Error('formato');
  const [h, p, s] = credencial.split('.');
  const cabecera = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (cabecera.alg !== 'RS256' || !cabecera.kid) throw new Error('algoritmo no permitido');

  let llave = (await obtenerLlavesGoogle(false)).find(k => k.kid === cabecera.kid);
  if (!llave) llave = (await obtenerLlavesGoogle(true)).find(k => k.kid === cabecera.kid); // Google rota sus llaves
  if (!llave) throw new Error('llave desconocida');

  const publica = crypto.createPublicKey({ key: llave, format: 'jwk' });
  const firmaOk = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publica, Buffer.from(s, 'base64url'));
  if (!firmaOk) throw new Error('firma inválida');

  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  const ahora = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('emisor inválido');
  if (!clientId || ![].concat(c.aud).includes(clientId)) throw new Error('audiencia inválida');
  if (!c.exp || c.exp <= ahora) throw new Error('token vencido');
  if (c.iat && c.iat > ahora + 300) throw new Error('token del futuro');
  if (!c.sub) throw new Error('sin sub');
  return c;
}

// ------------------------------------------------------------ nombres de usuario
function limpiarNombre(base) {
  const s = String(base ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 20);
  return s.length >= 3 ? s : (s + 'jugador').slice(0, 20);
}

async function nombreLibre(pool, base) {
  const limpio = limpiarNombre(base);
  let candidato = limpio;
  for (let i = 0; i < 10; i++) {
    const [r] = await pool.query('SELECT id FROM usuarios WHERE username = ?', [candidato]);
    if (r.length === 0) return candidato;
    candidato = limpio.slice(0, 16) + '_' + Math.floor(100 + Math.random() * 900);
  }
  return limpio.slice(0, 10) + '_' + Date.now().toString().slice(-6);
}

const publico = (u) => ({
  id: u.id,
  username: u.username,
  email: u.email && !u.email.endsWith('@invitado.local') ? u.email : null
});

module.exports = function montarAuth(app, pool) {
  const cacheProveedor = {};
  async function idProveedor(nombre) {
    if (cacheProveedor[nombre]) return cacheProveedor[nombre];
    const [r] = await pool.query('SELECT id FROM proveedores_auth WHERE nombre = ?', [nombre]);
    if (r.length) cacheProveedor[nombre] = r[0].id;
    return cacheProveedor[nombre] || null;
  }

  // Middleware: exige una sesión válida y deja al usuario en req.usuario
  async function requiereSesion(req, res, next) {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const datos = m && verificarSesion(m[1]);
      if (!datos) return res.status(401).json({ error: 'Sesión no válida o vencida. Inicia sesión de nuevo.' });
      const [rows] = await pool.query('SELECT id, username, email FROM usuarios WHERE id = ?', [datos.uid]);
      if (rows.length === 0) return res.status(401).json({ error: 'Esta cuenta ya no existe. Inicia sesión de nuevo.' });
      req.usuario = rows[0];
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // Qué opciones de acceso hay (el ID de cliente de Google es público)
  app.get('/api/auth/config', (req, res) => {
    res.json({
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      invitados: process.env.PERMITIR_INVITADOS !== 'false'
    });
  });

  // Entrar o registrarse con Google
  app.post('/api/auth/google', async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: 'El acceso con Google no está configurado en el servidor.' });

    let c;
    try { c = await verificarGoogle(req.body.credential, clientId); }
    catch (e) { return res.status(401).json({ error: 'No se pudo verificar tu cuenta de Google. Intenta de nuevo.' }); }
    if (!c.email || c.email_verified !== true) {
      return res.status(401).json({ error: 'Tu cuenta de Google no tiene un correo verificado.' });
    }

    try {
      const prov = await idProveedor('google');
      if (!prov) return res.status(503).json({ error: 'Falta el proveedor «google» en la tabla proveedores_auth.' });

      // La cuenta de Google se identifica por "sub" (el correo puede cambiar)
      const [rows] = await pool.query(
        'SELECT * FROM usuarios WHERE proveedor_auth_id = ? AND proveedor_uid = ?', [prov, c.sub]
      );
      let usuario = rows[0];
      let nuevo = false;

      if (!usuario) {
        const [porCorreo] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [c.email]);
        if (porCorreo.length > 0) {
          // Solo se enlaza una cuenta previa si Google es "autoridad" de ese correo (@gmail.com o Workspace)
          const autoridad = /@gmail\.com$/i.test(c.email) || !!c.hd;
          if (porCorreo[0].proveedor_auth_id !== prov || !autoridad) {
            return res.status(409).json({ error: 'Ese correo ya está registrado con otro método de acceso.' });
          }
          await pool.query('UPDATE usuarios SET proveedor_uid = ? WHERE id = ?', [c.sub, porCorreo[0].id]);
          usuario = porCorreo[0];
        } else {
          const nombre = await nombreLibre(pool, c.given_name || c.name || c.email.split('@')[0]);
          const [r] = await pool.query(
            'INSERT INTO usuarios (username, email, proveedor_auth_id, proveedor_uid) VALUES (?, ?, ?, ?)',
            [nombre, c.email, prov, c.sub]
          );
          usuario = { id: r.insertId, username: nombre, email: c.email };
          nuevo = true;
        }
      }
      res.json({ token: firmarSesion(usuario.id), usuario: publico(usuario), nuevo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Entrar sin cuenta (plan B). Se puede apagar con PERMITIR_INVITADOS=false
  app.post('/api/auth/invitado', async (req, res) => {
    if (process.env.PERMITIR_INVITADOS === 'false') {
      return res.status(403).json({ error: 'El acceso como invitado está desactivado.' });
    }
    const apodo = String(req.body.nombre ?? '').trim();
    if (!apodo) return res.status(400).json({ error: 'Escribe un apodo para jugar.' });
    try {
      const prov = await idProveedor('invitado');
      if (!prov) return res.status(503).json({ error: 'Falta ejecutar migracion_v4.sql en la base de datos.' });
      const uid = crypto.randomUUID();
      const nombre = await nombreLibre(pool, apodo);
      const email = `invitado-${uid}@invitado.local`;
      const [r] = await pool.query(
        'INSERT INTO usuarios (username, email, proveedor_auth_id, proveedor_uid) VALUES (?, ?, ?, ?)',
        [nombre, email, prov, uid]
      );
      const usuario = { id: r.insertId, username: nombre, email };
      res.json({ token: firmarSesion(usuario.id), usuario: publico(usuario), nuevo: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ¿Quién soy? (para recuperar la sesión al recargar la página)
  app.get('/api/auth/yo', requiereSesion, (req, res) => {
    res.json({ usuario: publico(req.usuario) });
  });

  return { requiereSesion };
};

module.exports.verificarGoogle = verificarGoogle;
module.exports.firmarSesion = firmarSesion;
module.exports.verificarSesion = verificarSesion;