// Importamos Mongoose, la librería que nos permite conectarnos a MongoDB
const mongoose = require("mongoose");

// Función asíncrona que establece la conexión con MongoDB Atlas
const connectDB = async () => {
  try {
    // Intentamos conectarnos usando la URI que viene de las variables de entorno
    // process.env.MONGO_URI lee el valor del archivo .env
    const conn = await mongoose.connect(process.env.MONGO_URI);

    // Si la conexión fue exitosa, mostramos el host al que nos conectamos
    console.log(`✅ MongoDB conectado: ${conn.connection.host}`);
  } catch (error) {
    // Si hubo un error (credenciales incorrectas, sin internet, etc.), lo mostramos
    console.error(`❌ Error al conectar a MongoDB: ${error.message}`);

    // Terminamos el proceso con código 1 (indica fallo)
    // Esto evita que el servidor arranque sin base de datos
    process.exit(1);
  }
};

// Exportamos la función para usarla desde server.js
module.exports = connectDB;
