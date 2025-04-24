// server.mjs
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const { Pool } = pkg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Example route
app.get('/', (req, res) => {
  res.send('Guessing Game Backend is Running');
});

// In-memory cache (you’ll later replace this with DB lookups)
let gameSessions = {}; // sessionId => { players, question, answer, ... }

io.on('connection', (socket) => {
  console.log(`🟢 New client connected: ${socket.id}`);

  socket.on('join-session', async ({ username, sessionId }) => {
    try {
      const userRes = await db.query(
        'INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username RETURNING *',
        [username]
      );
      const user = userRes.rows[0];

      if (!gameSessions[sessionId]) {
        gameSessions[sessionId] = {
          players: {},
          status: 'waiting'
        };
      }

      gameSessions[sessionId].players[socket.id] = {
        userId: user.id,
        username,
        attempts: 3,
        isWinner: false
      };

      socket.join(sessionId);
      io.to(sessionId).emit('session-update', gameSessions[sessionId]);

      console.log(`${username} joined session ${sessionId}`);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('create-question', ({ sessionId, question, answer }) => {
    if (gameSessions[sessionId]) {
      gameSessions[sessionId].question = question;
      gameSessions[sessionId].answer = answer.toLowerCase();
      gameSessions[sessionId].status = 'ready';
      io.to(sessionId).emit('question-created', question);
    }
  });

  socket.on('start-game', ({ sessionId }) => {
    if (gameSessions[sessionId]) {
      gameSessions[sessionId].status = 'in_progress';
      io.to(sessionId).emit('game-started', {
        question: gameSessions[sessionId].question
      });

      setTimeout(() => {
        if (gameSessions[sessionId].status === 'in_progress') {
          gameSessions[sessionId].status = 'ended';
          io.to(sessionId).emit('game-ended', {
            winner: null,
            answer: gameSessions[sessionId].answer
          });
        }
      }, 60000); // 60 seconds
    }
  });

  socket.on('make-guess', ({ sessionId, guess }) => {
    const session = gameSessions[sessionId];
    if (!session || session.status !== 'in_progress') return;

    const player = session.players[socket.id];
    if (!player || player.attempts === 0 || player.isWinner) return;

    player.attempts--;

    if (guess.toLowerCase() === session.answer) {
      session.status = 'ended';
      player.isWinner = true;
      io.to(sessionId).emit('game-ended', {
        winner: player.username,
        answer: session.answer
      });

      // Update DB score
      db.query('UPDATE users SET score = score + 10 WHERE id = $1', [player.userId]);
    } else {
      socket.emit('wrong-guess', { attemptsLeft: player.attempts });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
    for (const sessionId in gameSessions) {
      const players = gameSessions[sessionId].players;
      if (players && players[socket.id]) {
        delete players[socket.id];
        io.to(sessionId).emit('session-update', gameSessions[sessionId]);
      }

      if (Object.keys(players).length === 0) {
        delete gameSessions[sessionId];
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
