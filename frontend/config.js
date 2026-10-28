// ÚNICO lugar donde se configura a qué backend le habla el juego.
// En tu computador (localhost o abriendo el archivo) usa el backend local;
// desplegado usa el de Render. Cambia SOLO la URL de producción.
const API_URL =
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:')
    ? 'http://localhost:3000'
    : 'https://escape-room-rt5l.onrender.com';
