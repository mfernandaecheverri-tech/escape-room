const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
app.use(express.json());

// CORS: el frontend vive en OTRO dominio. En ALLOWED_ORIGINS pones la URL del
// frontend (sin "/" al final); varias separadas por coma. Sin definir, acepta todo.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));

app.get('/', (req, res) => {
  res.json({ ok: true, servicio: 'API Escape Room' });
});

// ---------------------------------------------------------------- utilidades
const normalizar = (v) => String(v ?? '').replace(/\s+/g, '').toLowerCase();

// Datos del jugador + su sala (para validar que quien pregunta de verdad juega ahí)
async function contextoJugador(jugadorSalaId) {
  const [rows] = await pool.query(
    `SELECT js.id AS jugador_sala_id, js.sala_id, js.rol_juego_id,
            s.estado, s.etapa_actual, s.juego_id
     FROM jugadores_sala js
     JOIN salas s ON js.sala_id = s.id
     WHERE js.id = ?`,
    [jugadorSalaId]
  );
  return rows[0] || null;
}

// Anti fuerza bruta: máximo un intento fallido cada 3 segundos por jugador
async function demasiadosIntentos(jugadorSalaId) {
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM historial_acciones
     WHERE jugador_sala_id = ? AND es_exitoso = FALSE
       AND fecha_hora > DATE_SUB(NOW(), INTERVAL 3 SECOND)`,
    [jugadorSalaId]
  );
  return n > 0;
}

async function registrarAccion(salaId, jugadorSalaId, descripcion, exitoso) {
  await pool.query(
    'INSERT INTO historial_acciones (sala_id, jugador_sala_id, accion_descripcion, es_exitoso) VALUES (?, ?, ?, ?)',
    [salaId, jugadorSalaId, descripcion, exitoso]
  );
}

// ---------------------------------------------------------------- auth
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
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

// ---------------------------------------------------------------- juegos
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
    const [rows] = await pool.query('SELECT * FROM roles_juego WHERE juego_id = ? ORDER BY id ASC', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- salas
app.post('/api/salas/crear', async (req, res) => {
  const { juego_id, anfitrion_id } = req.body;
  try {
    for (let intento = 0; intento < 6; intento++) {
      const codigo = 'LAB' + Math.floor(1000 + Math.random() * 9000);
      try {
        const [result] = await pool.query(
          'INSERT INTO salas (codigo_acceso, juego_id, anfitrion_id, estado) VALUES (?, ?, ?, ?)',
          [codigo, juego_id, anfitrion_id, 'EN_ESPERA']
        );
        return res.json({ id: result.insertId, codigo_acceso: codigo });
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY' && !/UNIQUE/i.test(err.message)) throw err; // código repetido: reintenta
      }
    }
    res.status(500).json({ error: 'No se pudo generar un código de sala. Intenta de nuevo.' });
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
      'SELECT min_jugadores, max_jugadores FROM juegos WHERE id = ?', [sala.juego_id]
    );
    const juego = juegoRows[0];

    // ¿Ya estaba en la sala? (reconexión)
    const [existente] = await pool.query(
      `SELECT js.id, js.rol_juego_id, r.nombre_rol, r.descripcion
       FROM jugadores_sala js JOIN roles_juego r ON js.rol_juego_id = r.id
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
          descripcion: existente[0].descripcion,
          jugador_sala_id: existente[0].id
        }
      });
    }

    if (sala.estado !== 'EN_ESPERA') {
      return res.status(400).json({ error: 'La sala ya empezó o terminó. Crea una nueva.' });
    }

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM jugadores_sala WHERE sala_id = ?', [sala.id]
    );
    if (total >= juego.max_jugadores) {
      return res.status(400).json({ error: `La sala está llena (máximo ${juego.max_jugadores} jugadores).` });
    }

    // Rol en el SERVIDOR: el primer rol libre, en orden.
    const [rolesLibres] = await pool.query(
      `SELECT rj.* FROM roles_juego rj
       WHERE rj.juego_id = ?
         AND rj.id NOT IN (SELECT rol_juego_id FROM jugadores_sala WHERE sala_id = ?)
       ORDER BY rj.id ASC`,
      [sala.juego_id, sala.id]
    );
    if (rolesLibres.length === 0) {
      return res.status(400).json({ error: 'La sala está llena (no hay roles disponibles).' });
    }
    const rolAsignado = rolesLibres[0];

    const [result] = await pool.query(
      'INSERT INTO jugadores_sala (sala_id, usuario_id, rol_juego_id, esta_listo, esta_conectado) VALUES (?, ?, ?, TRUE, TRUE)',
      [sala.id, usuario_id, rolAsignado.id]
    );

    res.json({
      sala,
      min_jugadores: juego.min_jugadores,
      rol: {
        id: rolAsignado.id,
        nombre_rol: rolAsignado.nombre_rol,
        descripcion: rolAsignado.descripcion,
        jugador_sala_id: result.insertId
      }
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
       WHERE js.sala_id = ?
       ORDER BY js.rol_juego_id ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/salas/:id/iniciar', async (req, res) => {
  try {
    const [salas] = await pool.query(
      'SELECT s.estado, j.min_jugadores FROM salas s JOIN juegos j ON s.juego_id = j.id WHERE s.id = ?',
      [req.params.id]
    );
    if (salas.length === 0) return res.status(404).json({ error: 'Sala no encontrada' });

    // Si ya estaba iniciada (o terminada) no se toca: así el cronómetro no se reinicia.
    if (salas[0].estado !== 'EN_ESPERA') return res.json({ status: 'ok', estado: salas[0].estado });

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM jugadores_sala WHERE sala_id = ?', [req.params.id]
    );
    if (total < salas[0].min_jugadores) {
      return res.status(400).json({ error: `Faltan jugadores (mínimo ${salas[0].min_jugadores}).` });
    }

    await pool.query(
      'UPDATE salas SET estado = ?, fecha_inicio = NOW(), etapa_actual = 1 WHERE id = ? AND estado = ?',
      ['EN_PROGRESO', req.params.id, 'EN_ESPERA']
    );
    res.json({ status: 'ok', estado: 'EN_PROGRESO' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Estado de la sala: etapa, tiempo restante, y marca FALLIDO si se acabó el tiempo.
app.get('/api/salas/:id/estado', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.id, s.estado, s.etapa_actual, j.tiempo_limite_minutos,
              CASE WHEN s.fecha_inicio IS NULL THEN NULL
                   ELSE TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(s.fecha_inicio, INTERVAL j.tiempo_limite_minutos MINUTE))
              END AS segundos_restantes
       FROM salas s JOIN juegos j ON s.juego_id = j.id
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Sala no encontrada' });
    const sala = rows[0];

    if (sala.estado === 'EN_PROGRESO' && sala.segundos_restantes !== null && Number(sala.segundos_restantes) <= 0) {
      await pool.query(
        'UPDATE salas SET estado = ?, fecha_fin = NOW() WHERE id = ? AND estado = ?',
        ['FALLIDO', sala.id, 'EN_PROGRESO']
      );
      sala.estado = 'FALLIDO';
    }
    res.json(sala);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Escena de la etapa actual SEGÚN EL ROL del jugador: plataformas y decorado
// para todos, pero las pistas solo del rol dueño. Nunca se envía la respuesta.
app.get('/api/salas/:id/escena', async (req, res) => {
  try {
    const ctx = await contextoJugador(req.query.jugador_sala_id);
    if (!ctx || String(ctx.sala_id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Jugador no válido para esta sala.' });
    }

    const [etapas] = await pool.query(
      'SELECT * FROM etapas WHERE juego_id = ? AND numero_etapa = ?',
      [ctx.juego_id, ctx.etapa_actual]
    );
    if (etapas.length === 0) return res.status(404).json({ error: 'Etapa no encontrada' });
    const etapa = etapas[0];

    const [[{ total_etapas }]] = await pool.query(
      'SELECT COUNT(*) AS total_etapas FROM etapas WHERE juego_id = ?', [ctx.juego_id]
    );

    const [objetos] = await pool.query(
      `SELECT id, tipo, nombre, icono, x, y, ancho, alto, texto
       FROM objetos_etapa
       WHERE etapa_id = ? AND (rol_juego_id IS NULL OR rol_juego_id = ?)
       ORDER BY id ASC`,
      [etapa.id, ctx.rol_juego_id]
    );

    const [acertijos] = await pool.query(
      'SELECT id, pista_texto, puntos_otorgados FROM acertijos WHERE etapa_id = ? AND rol_juego_id = ?',
      [etapa.id, ctx.rol_juego_id]
    );
    let acertijo = null;
    if (acertijos.length > 0) {
      const [prog] = await pool.query(
        'SELECT id FROM progreso_acertijos WHERE jugador_sala_id = ? AND acertijo_id = ?',
        [ctx.jugador_sala_id, acertijos[0].id]
      );
      acertijo = { ...acertijos[0], resuelto: prog.length > 0 };
    }

    res.json({ etapa, total_etapas, objetos, acertijo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equipo de la sala (en orden de rol) y quién ya resolvió su acertijo de la etapa actual
app.get('/api/salas/:id/equipo', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT js.rol_juego_id, rj.nombre_rol, u.username,
              EXISTS(
                SELECT 1 FROM progreso_acertijos p
                JOIN acertijos a ON p.acertijo_id = a.id
                JOIN etapas e ON a.etapa_id = e.id
                WHERE p.jugador_sala_id = js.id AND e.juego_id = s.juego_id AND e.numero_etapa = s.etapa_actual
              ) AS resuelto
       FROM jugadores_sala js
       JOIN usuarios u ON js.usuario_id = u.id
       JOIN roles_juego rj ON js.rol_juego_id = rj.id
       JOIN salas s ON js.sala_id = s.id
       WHERE js.sala_id = ?
       ORDER BY js.rol_juego_id ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({ ...r, resuelto: Number(r.resuelto) === 1 })));
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

// ---------------------------------------------------------------- acertijos
// Acertijo PERSONAL: solo se puede resolver el de tu rol en la etapa actual.
app.post('/api/acertijos/:id/verificar', async (req, res) => {
  const { respuesta, jugador_sala_id } = req.body;
  try {
    if (!jugador_sala_id) return res.status(400).json({ error: 'Falta el jugador.' });
    const ctx = await contextoJugador(jugador_sala_id);
    if (!ctx) return res.status(403).json({ error: 'Jugador no válido.' });
    if (ctx.estado !== 'EN_PROGRESO') return res.status(400).json({ error: 'La sala no está en juego.' });

    const [rows] = await pool.query(
      `SELECT a.* FROM acertijos a
       JOIN etapas e ON a.etapa_id = e.id
       WHERE a.id = ? AND e.juego_id = ? AND e.numero_etapa = ? AND a.rol_juego_id = ?`,
      [req.params.id, ctx.juego_id, ctx.etapa_actual, ctx.rol_juego_id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'Ese acertijo no es tuyo en esta etapa.' });
    const acertijo = rows[0];

    const [yaResuelto] = await pool.query(
      'SELECT id FROM progreso_acertijos WHERE jugador_sala_id = ? AND acertijo_id = ?',
      [ctx.jugador_sala_id, acertijo.id]
    );
    if (yaResuelto.length > 0) return res.json({ correcto: true, ya_resuelto: true, puntos: 0 });

    if (await demasiadosIntentos(ctx.jugador_sala_id)) {
      return res.status(429).json({ error: 'Piensa un poco más: espera unos segundos antes de reintentar.' });
    }

    const esCorrecto = normalizar(respuesta) === normalizar(acertijo.respuesta_codigo);
    await registrarAccion(
      ctx.sala_id, ctx.jugador_sala_id,
      `${esCorrecto ? 'Acertijo resuelto' : 'Intento fallido del acertijo'} #${acertijo.id}`, esCorrecto
    );
    if (esCorrecto) {
      await pool.query(
        'INSERT IGNORE INTO progreso_acertijos (jugador_sala_id, acertijo_id) VALUES (?, ?)',
        [ctx.jugador_sala_id, acertijo.id]
      );
    }
    res.json({ correcto: esCorrecto, puntos: esCorrecto ? acertijo.puntos_otorgados : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Puerta de la etapa: el EQUIPO debe aportar la respuesta de cada rol presente.
// Se responde solo si/no (nunca cuál falló) para que no se pueda adivinar rol por rol.
app.post('/api/salas/:id/puerta', async (req, res) => {
  const { respuestas, jugador_sala_id } = req.body; // respuestas: { "<rol_juego_id>": "valor" }
  try {
    const ctx = await contextoJugador(jugador_sala_id);
    if (!ctx || String(ctx.sala_id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'Jugador no válido para esta sala.' });
    }
    if (ctx.estado !== 'EN_PROGRESO') return res.status(400).json({ error: 'La sala no está en juego.' });

    if (await demasiadosIntentos(ctx.jugador_sala_id)) {
      return res.status(429).json({ error: 'Esperen unos segundos antes de volver a intentar la puerta.' });
    }

    const [filas] = await pool.query(
      `SELECT js.rol_juego_id, a.respuesta_codigo
       FROM jugadores_sala js
       JOIN acertijos a ON a.rol_juego_id = js.rol_juego_id
       JOIN etapas e ON a.etapa_id = e.id AND e.juego_id = ? AND e.numero_etapa = ?
       WHERE js.sala_id = ?`,
      [ctx.juego_id, ctx.etapa_actual, ctx.sala_id]
    );
    const correcto = filas.length > 0 && filas.every(
      f => normalizar((respuestas || {})[f.rol_juego_id]) === normalizar(f.respuesta_codigo)
    );

    await registrarAccion(
      ctx.sala_id, ctx.jugador_sala_id,
      `${correcto ? 'Puerta abierta' : 'Intento fallido de la puerta'} (etapa ${ctx.etapa_actual})`, correcto
    );
    if (!correcto) return res.json({ correcto: false });

    const [[{ ultima }]] = await pool.query(
      'SELECT MAX(numero_etapa) AS ultima FROM etapas WHERE juego_id = ?', [ctx.juego_id]
    );

    if (ctx.etapa_actual >= ultima) {
      await pool.query(
        'UPDATE salas SET estado = ?, fecha_fin = NOW() WHERE id = ? AND estado = ?',
        ['RESUELTO', ctx.sala_id, 'EN_PROGRESO']
      );
      return res.json({ correcto: true, salaCompleta: true });
    }

    await pool.query(
      'UPDATE salas SET etapa_actual = ? WHERE id = ? AND etapa_actual = ?',
      [ctx.etapa_actual + 1, ctx.sala_id, ctx.etapa_actual]
    );
    res.json({ correcto: true, salaCompleta: false, etapa_actual: ctx.etapa_actual + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- inventario (se conserva)
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