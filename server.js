const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mysql = require('mysql2/promise'); // Using promise-based API
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MySQL connection pool
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root', 
  password: '',
  database: 'classchat',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initDB() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    // Create users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_role CHECK (role IN ('student', 'teacher'))
      )
    `);
   
    // Create messages table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id)
      )
    `);
   
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    if (connection) connection.release();
  }
}

initDB();

// Middleware (unchanged)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'class-chat-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Routes (unchanged)
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/chat');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/chat', (req, res) => {
  if (req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  } else {
    res.redirect('/');
  }
});

// Authentication routes (modified for MySQL)
app.post('/api/register', async (req, res) => {
  const { username, password, role } = req.body;
 
  try {
    const connection = await pool.getConnection();
    
    // Check if user exists
    const [userCheck] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    if (userCheck.length > 0) {
      connection.release();
      return res.status(400).json({ error: 'Username already exists' });
    }
   
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
   
    // Insert new user
    const [result] = await connection.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role]
    );
    
    // Get inserted user
    const [rows] = await connection.query('SELECT id, username, role FROM users WHERE id = ?', [result.insertId]);
    const user = rows[0];
    
    connection.release();
    
    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
   
    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
 
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    connection.release();
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
   
    const user = rows[0];
   
    // Compare password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
   
    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
   
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

// Chat API (modified for MySQL)
app.get('/api/messages', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
 
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT m.id, m.content, m.created_at, u.username, u.role
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      ORDER BY m.created_at DESC
      LIMIT 50
    `);
    connection.release();
   
    res.json(rows.reverse());
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO connection (unchanged)
io.on('connection', (socket) => {
  console.log('New client connected');
 
  socket.on('join', (userData) => {
    socket.join('classroom');
    socket.user = userData;
    io.to('classroom').emit('userJoined', {
      username: userData.username,
      role: userData.role,
      timestamp: new Date()
    });
  });
 
  socket.on('message', async (messageData) => {
    try {
      const connection = await pool.getConnection();
      const [result] = await connection.query(
        'INSERT INTO messages (sender_id, content) VALUES (?, ?)',
        [messageData.userId, messageData.message]
      );
      connection.release();
     
      const savedMessage = {
        id: result.insertId,
        content: messageData.message,
        created_at: new Date(),
        username: messageData.username,
        role: messageData.role
      };
     
      io.to('classroom').emit('message', savedMessage);
    } catch (err) {
      console.error('Error saving message:', err);
      socket.emit('error', { message: 'Failed to save message' });
    }
  });
 
  socket.on('disconnect', () => {
    if (socket.user) {
      io.to('classroom').emit('userLeft', {
        username: socket.user.username,
        timestamp: new Date()
      });
    }
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});