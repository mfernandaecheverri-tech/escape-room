const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// CORS: el frontend vive en OTRO dominio (sitio estático aparte), así que el
// backend tiene que permitirle hacer peticiones. En ALLOWED_ORIGINS pones la
// URL del frontend (sin "/" al final); varias separadas por coma.
// Si no la defines, acepta cualquier origen (útil solo para pruebas locales).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));

// Ruta de salud: sirve para comprobar que el backend está vivo.
app.get('/', (req, res) => {
  res.json({ ok: true, servicio: 'API Escape Room' });
});

// Usamos el pool único definido en db.js (que ya carga dotenv y configura SSL).
// Antes index.js creaba su PROPIO pool sin ssl y sin dotenv.config() -> por eso
// fallaba localmente y era inconsistente con Render.
const pool = require('./db');

// --- API AUTENTICACIÓN / USUARIOS ---
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ usuario: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/registro', async (req, res) => {
  const { username } = req.body;
  try {
    const email = `${username}@gmail.com`;
    const [result] = await pool.query(
      'INSERT INTO usuarios (username, email, proveedor_auth_id, proveedor_uid) VALUES (?, ?, 1, ?)',
      [username, email, `sub_${username}`]
    );
    res.json({ id: result.insertId, username });
  } catch (err) {
    res.status(400).json({ error: 'El usuario ya existe o hubo un problema al crearlo.' });
  }
});

// --- API JUEGOS, ETAPAS Y ROLES ---
app.get('/api/juegos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM juegos WHERE es_activo = TRUE');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/juegos/:id/roles', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM roles_juego WHERE juego_id = ?', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/juegos/:id/etapas', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM etapas WHERE juego_id = ? ORDER BY numero_etapa ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API ACERTIJOS ---
// Nunca se envía respuesta_codigo al cliente: solo la pista y metadatos.
app.get('/api/etapas/:id/acertijos', async (req, res) => {
  const { rol_juego_id } = req.query;
  try {
    let query = 'SELECT id, etapa_id, rol_juego_id, pista_texto, puntos_otorgados FROM acertijos WHERE etapa_id = ?';
    const params = [req.params.id];
    if (rol_juego_id) {
      query += ' AND (rol_juego_id = ? OR rol_juego_id IS NULL)';
      params.push(rol_juego_id);
    }
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/acertijos/:id/verificar', async (req, res) => {
  const { respuesta, jugador_sala_id } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM acertijos WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Acertijo no encontrado' });

    const acertijo = rows[0];
    const esCorrecto = String(respuesta || '').trim().toLowerCase() === String(acertijo.respuesta_codigo).trim().toLowerCase();

    let salaCompleta = false;

    if (jugador_sala_id) {
      const [jsRows] = await pool.query('SELECT sala_id FROM jugadores_sala WHERE id = ?', [jugador_sala_id]);
      const salaId = jsRows[0]?.sala_id;

      if (salaId) {
        await pool.query(
          'INSERT INTO historial_acciones (sala_id, jugador_sala_id, accion_descripcion, es_exitoso) VALUES (?, ?, ?, ?)',
          [salaId, jugador_sala_id, `Intento de acertijo #${acertijo.id}`, esCorrecto]
        );

        if (esCorrecto) {
          // Cooperativo: la sala solo se marca RESUELTO cuando TODOS los
          // jugadores de la sala ya tuvieron al menos un intento exitoso.
          const [[{ totalJugadores }]] = await pool.query(
            'SELECT COUNT(*) AS totalJugadores FROM jugadores_sala WHERE sala_id = ?', [salaId]
          );
          const [[{ totalResueltos }]] = await pool.query(
            `SELECT COUNT(DISTINCT jugador_sala_id) AS totalResueltos
             FROM historial_acciones WHERE sala_id = ? AND es_exitoso = TRUE`,
            [salaId]
          );
          if (totalJugadores > 0 && totalResueltos >= totalJugadores) {
            await pool.query('UPDATE salas SET estado = ?, fecha_fin = NOW() WHERE id = ?', ['RESUELTO', salaId]);
            salaCompleta = true;
          }
        }
      }
    }

    res.json({ correcto: esCorrecto, puntos: esCorrecto ? acertijo.puntos_otorgados : 0, salaCompleta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API SALAS ---
app.post('/api/salas/crear', async (req, res) => {
  const { juego_id, anfitrion_id } = req.body;
  const codigo = 'LAB' + Math.floor(100 + Math.random() * 900);
  try {
    const [result] = await pool.query(
      // OJO: el ENUM de "estado" es EN_ESPERA / EN_PROGRESO / RESUELTO / FALLIDO / CANCELADA.
      // "ESPERANDO" no existe en el ENUM y hacía fallar el insert.
      // Usamos ? en vez de comillas dobles porque Aiven corre con sql_mode=ANSI_QUOTES,
      // donde "texto" se interpreta como nombre de columna, no como string.
      'INSERT INTO salas (codigo_acceso, juego_id, anfitrion_id, estado) VALUES (?, ?, ?, ?)',
      [codigo, juego_id, anfitrion_id, 'EN_ESPERA']
    );
    res.json({ id: result.insertId, codigo_acceso: codigo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/salas/unirse', async (req, res) => {
  const { codigo_acceso, usuario_id } = req.body;
  try {
    const [salas] = await pool.query('SELECT * FROM salas WHERE codigo_acceso = ?', [codigo_acceso]);
    if (salas.length === 0) return res.status(404).json({ error: 'Sala no encontrada' });
    const sala = salas[0];

    const [juegoRows] = await pool.query(
      'SELECT min_jugadores, max_jugadores FROM juegos WHERE id = ?',
      [sala.juego_id]
    );
    const juego = juegoRows[0];

    // Si el usuario ya estaba en la sala (reconexión), no lo volvemos a insertar.
    const [existente] = await pool.query(
      `SELECT js.*, r.nombre_rol FROM jugadores_sala js
       JOIN roles_juego r ON js.rol_juego_id = r.id
       WHERE js.sala_id = ? AND js.usuario_id = ?`,
      [sala.id, usuario_id]
    );
    if (existente.length > 0) {
      await pool.query('UPDATE jugadores_sala SET esta_conectado = TRUE WHERE id = ?', [existente[0].id]);
      return res.json({
        sala,
        min_jugadores: juego.min_jugadores,
        rol: {
          id: existente[0].rol_juego_id,
          nombre_rol: existente[0].nombre_rol,
          jugador_sala_id: existente[0].id
        }
      });
    }

    // Asignación de rol en el SERVIDOR (no al azar en el cliente): tomamos el primer
    // rol del juego que aún no esté ocupado en esta sala. Así se respeta el
    // UNIQUE (sala_id, rol_juego_id) sin choques por aleatoriedad.
    const [rolesLibres] = await pool.query(
      `SELECT rj.* FROM roles_juego rj
       WHERE rj.juego_id = ?
       AND rj.id NOT IN (
         SELECT rol_juego_id FROM jugadores_sala WHERE sala_id = ?
       )`,
      [sala.juego_id, sala.id]
    );
    if (rolesLibres.length === 0) {
      return res.status(400).json({ error: 'La sala está llena (no hay roles disponibles)' });
    }
    const rolAsignado = rolesLibres[0];

    const [result] = await pool.query(
      'INSERT INTO jugadores_sala (sala_id, usuario_id, rol_juego_id, esta_listo, esta_conectado) VALUES (?, ?, ?, TRUE, TRUE)',
      [sala.id, usuario_id, rolAsignado.id]
    );

    res.json({
      sala,
      min_jugadores: juego.min_jugadores,
      rol: { ...rolAsignado, jugador_sala_id: result.insertId }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/salas/:id/jugadores', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT js.*, u.username, r.nombre_rol
       FROM jugadores_sala js
       JOIN usuarios u ON js.usuario_id = u.id
       LEFT JOIN roles_juego r ON js.rol_juego_id = r.id
       WHERE js.sala_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/salas/:id/iniciar', async (req, res) => {
  try {
    await pool.query(
      'UPDATE salas SET estado = ?, fecha_inicio = NOW() WHERE id = ?',
      ['EN_PROGRESO', req.params.id]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/salas/:id/finalizar', async (req, res) => {
  const { estado } = req.body; // 'RESUELTO' o 'FALLIDO'
  if (!['RESUELTO', 'FALLIDO'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  try {
    await pool.query('UPDATE salas SET estado = ?, fecha_fin = NOW() WHERE id = ?', [estado, req.params.id]);
    res.json({ status: 'ok', estado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/salas/:id/objetos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM estado_objetos_sala WHERE sala_id = ?', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API INVENTARIO ---
app.get('/api/salas/:salaId/inventario/:usuarioId', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT inv.* FROM inventario_jugador inv
       JOIN jugadores_sala js ON inv.jugador_sala_id = js.id
       WHERE js.sala_id = ? AND js.usuario_id = ?`,
      [req.params.salaId, req.params.usuarioId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
