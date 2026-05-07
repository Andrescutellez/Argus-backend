require('dotenv').config();

if (!process.env.MONGO_URI) {
  console.error('ERROR: MONGO_URI is not defined. Set it in .env or environment variables.');
  process.exit(1);
}

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const gpsRoutes = require('./routes/gps');
const deviceRoutes = require('./routes/device');
const { startTcpServer } = require('./tcp/tcpServer');
const { startWorker } = require('./tcp/queue');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

connectDB();
startWorker();
startTcpServer(io);

app.use(express.json());
app.use(cors());

app.get('/', (req, res) => res.send('Argus backend active'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/gps', gpsRoutes);
app.use('/api/device', deviceRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Argus backend running on port ${PORT}`);
});

module.exports = { io };
