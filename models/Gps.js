// Importamos Mongoose para poder crear el esquema (estructura) del documento
const mongoose = require("mongoose");

// Definimos el esquema: le decimos a MongoDB qué campos tendrá cada registro GPS
const GpsSchema = new mongoose.Schema({
  // Identificador del dispositivo ESP32 (ej: "ESP32-001")
  deviceId: {
    type: String,       // Tipo de dato: texto
    required: true,     // Campo obligatorio: si no viene, se rechaza
    trim: true,         // Elimina espacios en blanco al inicio y final
  },

  // Latitud geográfica del dispositivo
  lat: {
    type: Number,       // Tipo de dato: número decimal
    required: true,     // Campo obligatorio
  },

  // Longitud geográfica del dispositivo
  lon: {
    type: Number,       // Tipo de dato: número decimal
    required: true,     // Campo obligatorio
  },

  // Velocidad del dispositivo en km/h (opcional)
  speed: {
    type: Number,       // Tipo de dato: número
    default: 0,         // Si no se envía, se guarda como 0
  },

  // Fecha y hora en que se recibió el dato
  timestamp: {
    type: Date,         // Tipo de dato: fecha
    default: Date.now,  // Si no se envía, se usa la fecha actual del servidor
  },
});

// Creamos el modelo "Gps" a partir del esquema
// Mongoose creará automáticamente una colección llamada "gps" en MongoDB
const Gps = mongoose.model("Gps", GpsSchema);

// Exportamos el modelo para usarlo en el controlador
module.exports = Gps;
