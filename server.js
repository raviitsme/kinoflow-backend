const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const cors = require("cors");
const socketHandler = require("./sockets/socketHandler");
require("dotenv").config();

const app = express();
app.use(cors());


app.get("/", (req, res) => {
    res.status(200).json({
        status: "Active",
        message: "Backend running...",
        service: "KinoFlow",
    });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors : {
        origin : "*",
        methods : ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    socketHandler(io, socket);
})

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serving the backend at http://localhost:${PORT}`)
});
