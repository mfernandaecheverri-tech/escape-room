// CRUD genérico del panel de administración (/admin.html).
// Solo se pueden tocar las tablas y columnas de esta lista blanca. Se protege con la
// variable de entorno ADMIN_KEY (cabecera x-admin-key): sin ella, el panel queda deshabilitado.

const SI_NO = [{ n: 'es_activo', t: 'bool' }];

const TABLAS = {
  juegos: {
    etiqueta: 'Juegos', filaEtiqueta: 'titulo',
    lista: ['id', 'titulo', 'ambiente', 'tiempo_limite_minutos', 'min_jugadores', 'max_jugadores', 'es_activo'],
    campos: [
      { n: 'titulo', t: 'text', req: true },
      { n: 'descripcion', t: 'textarea' },
      { n: 'tiempo_limite_minutos', t: 'number', req: true },
      { n: 'min_jugadores', t: 'number', req: true },
      { n: 'max_jugadores', t: 'number', req: true },
      { n: 'es_activo', t: 'bool' },
      { n: 'ambiente', t: 'enum', opciones: ['normal', 'terror'], req: true }
    ]
  },
  roles_juego: {
    etiqueta: 'Roles del juego', filaEtiqueta: 'nombre_rol',
    lista: ['id', 'juego_id', 'nombre_rol', 'descripcion'],
    campos: [
      { n: 'juego_id', t: 'fk', fk: 'juegos', req: true },
      { n: 'nombre_rol', t: 'text', req: true },
      { n: 'descripcion', t: 'textarea' }
    ]
  },
  etapas: {
    etiqueta: 'Etapas', filaEtiqueta: 'titulo_etapa',
    lista: ['id', 'juego_id', 'numero_etapa', 'titulo_etapa', 'tema'],
    campos: [
      { n: 'juego_id', t: 'fk', fk: 'juegos', req: true },
      { n: 'numero_etapa', t: 'number', req: true },
      { n: 'titulo_etapa', t: 'text', req: true },
      { n: 'descripcion', t: 'textarea' },
      { n: 'tema', t: 'text' }
    ]
  },
  acertijos: {
    etiqueta: 'Acertijos', filaEtiqueta: 'id',
    lista: ['id', 'etapa_id', 'rol_juego_id', 'pista_texto', 'respuesta_codigo', 'puntos_otorgados'],
    campos: [
      { n: 'etapa_id', t: 'fk', fk: 'etapas', req: true },
      { n: 'rol_juego_id', t: 'fk', fk: 'roles_juego' },
      { n: 'pista_texto', t: 'textarea', req: true },
      { n: 'respuesta_codigo', t: 'text', req: true },
      { n: 'puntos_otorgados', t: 'number', req: true }
    ]
  },
  objetos_etapa: {
    etiqueta: 'Objetos de las etapas', filaEtiqueta: 'nombre',
    lista: ['id', 'etapa_id', 'rol_juego_id', 'tipo', 'nombre', 'icono', 'x', 'y', 'efecto'],
    campos: [
      { n: 'etapa_id', t: 'fk', fk: 'etapas', req: true },
      { n: 'rol_juego_id', t: 'fk', fk: 'roles_juego' },
      { n: 'tipo', t: 'enum', opciones: ['PLATAFORMA', 'PISTA', 'PUERTA', 'DECORADO'], req: true },
      { n: 'nombre', t: 'text', req: true },
      { n: 'icono', t: 'text' },
      { n: 'x', t: 'number', req: true },
      { n: 'y', t: 'number', req: true },
      { n: 'ancho', t: 'number', req: true },
      { n: 'alto', t: 'number', req: true },
      { n: 'texto', t: 'textarea' },
      { n: 'efecto', t: 'text' }
    ]
  },
  usuarios: {
    etiqueta: 'Usuarios', filaEtiqueta: 'username',
    lista: ['id', 'username', 'email', 'fecha_registro'],
    campos: [
      { n: 'username', t: 'text', req: true },
      { n: 'email', t: 'text', req: true },
      { n: 'proveedor_auth_id', t: 'number', req: true, def: 1 },
      { n: 'proveedor_uid', t: 'text', req: true }
    ]
  },
  salas: {
    etiqueta: 'Salas', filaEtiqueta: 'codigo_acceso', soloEditar: true,
    lista: ['id', 'codigo_acceso', 'juego_id', 'estado', 'etapa_actual', 'fecha_creacion'],
    campos: [
      { n: 'estado', t: 'enum', opciones: ['EN_ESPERA', 'EN_PROGRESO', 'RESUELTO', 'FALLIDO', 'CANCELADA'], req: true },
      { n: 'etapa_actual', t: 'number', req: true }
    ]
  }
};

function convertir(c, v) {
  const vacio = v === undefined || v === null || v === '';
  if (vacio) {
    if (c.req && c.t !== 'bool') return { error: `El campo «${c.n}» es obligatorio.` };
    return { valor: c.t === 'bool' ? 0 : null };
  }
  switch (c.t) {
    case 'number':
    case 'fk': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `El campo «${c.n}» debe ser un número.` };
      return { valor: Math.trunc(n) };
    }
    case 'bool':
      return { valor: (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0 };
    case 'enum':
      if (!c.opciones.includes(v)) return { error: `Valor no válido para «${c.n}».` };
      return { valor: v };
    default:
      return { valor: String(v) };
  }
}

function mensajeError(err) {
  const m = String(err.message || err);
  if (err.code === 'ER_ROW_IS_REFERENCED_2' || /FOREIGN KEY constraint failed/i.test(m))
    return { status: 409, error: 'No se puede completar: hay datos relacionados (otras tablas dependen de este registro).' };
  if (err.code === 'ER_DUP_ENTRY' || /UNIQUE constraint/i.test(m))
    return { status: 409, error: 'Ya existe un registro con ese valor único (usuario, correo, código...).' };
  if (err.code === 'ER_NO_REFERENCED_ROW_2')
    return { status: 400, error: 'El valor elegido no existe en la tabla relacionada.' };
  return { status: 500, error: m };
}

module.exports = function montarAdmin(app, pool) {
  function autorizado(req, res) {
    const clave = process.env.ADMIN_KEY;
    if (!clave) {
      res.status(503).json({ error: 'Panel deshabilitado: define la variable ADMIN_KEY en el servidor.' });
      return false;
    }
    if (req.headers['x-admin-key'] !== clave) {
      res.status(401).json({ error: 'Clave de administrador incorrecta.' });
      return false;
    }
    return true;
  }
  const tablaDe = (req, res) => {
    const t = TABLAS[req.params.tabla];
    if (!t) res.status(404).json({ error: 'Tabla no permitida.' });
    return t;
  };

  app.get('/api/admin/meta', (req, res) => {
    if (!autorizado(req, res)) return;
    const meta = {};
    for (const [nombre, t] of Object.entries(TABLAS)) {
      meta[nombre] = { etiqueta: t.etiqueta, filaEtiqueta: t.filaEtiqueta, lista: t.lista, campos: t.campos, soloEditar: !!t.soloEditar };
    }
    res.json(meta);
  });

  app.get('/api/admin/:tabla', async (req, res) => {
    if (!autorizado(req, res)) return;
    const t = tablaDe(req, res); if (!t) return;
    try {
      const [rows] = await pool.query(`SELECT * FROM \`${req.params.tabla}\` ORDER BY id ASC LIMIT 1000`);
      res.json(rows);
    } catch (err) { const e = mensajeError(err); res.status(e.status).json({ error: e.error }); }
  });

  app.post('/api/admin/:tabla', async (req, res) => {
    if (!autorizado(req, res)) return;
    const t = tablaDe(req, res); if (!t) return;
    if (t.soloEditar) return res.status(405).json({ error: 'Esta tabla no permite crear registros desde el panel.' });
    try {
      const cols = [], vals = [];
      for (const c of t.campos) {
        const r = convertir(c, req.body[c.n] === undefined && c.def !== undefined ? c.def : req.body[c.n]);
        if (r.error) return res.status(400).json({ error: r.error });
        cols.push('`' + c.n + '`'); vals.push(r.valor);
      }
      const [r] = await pool.query(
        `INSERT INTO \`${req.params.tabla}\` (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals
      );
      res.json({ id: r.insertId });
    } catch (err) { const e = mensajeError(err); res.status(e.status).json({ error: e.error }); }
  });

  app.put('/api/admin/:tabla/:id', async (req, res) => {
    if (!autorizado(req, res)) return;
    const t = tablaDe(req, res); if (!t) return;
    try {
      const sets = [], vals = [];
      for (const c of t.campos) {
        if (req.body[c.n] === undefined) continue;
        const r = convertir(c, req.body[c.n]);
        if (r.error) return res.status(400).json({ error: r.error });
        sets.push('`' + c.n + '` = ?'); vals.push(r.valor);
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No hay cambios que guardar.' });
      const [r] = await pool.query(
        `UPDATE \`${req.params.tabla}\` SET ${sets.join(', ')} WHERE id = ?`, [...vals, req.params.id]
      );
      res.json({ ok: true, cambiados: r.affectedRows });
    } catch (err) { const e = mensajeError(err); res.status(e.status).json({ error: e.error }); }
  });

  app.delete('/api/admin/:tabla/:id', async (req, res) => {
    if (!autorizado(req, res)) return;
    const t = tablaDe(req, res); if (!t) return;
    try {
      const [r] = await pool.query(`DELETE FROM \`${req.params.tabla}\` WHERE id = ?`, [req.params.id]);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Registro no encontrado.' });
      res.json({ ok: true });
    } catch (err) { const e = mensajeError(err); res.status(e.status).json({ error: e.error }); }
  });
};