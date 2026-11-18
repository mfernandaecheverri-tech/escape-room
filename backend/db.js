const mysql = require('mysql2/promise');
require('dotenv').config();

// Crear el pool de conexiones
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  
  ssl: {
    rejectUnauthorized: false
  }
});

// Probar la conexión
pool.getConnection()
  .then(connection => {
    console.log('✅ Conexión exitosa a la Base de Datos MySQL (Aiven)');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Error al conectar a la Base de Datos:', err.message);
  });

module.exports = pool;
