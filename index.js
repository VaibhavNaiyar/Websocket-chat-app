const http = require("http");
const express = require("express");
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store chat history and active users
const chatHistory = {};
const activeUsers = {};
const typingUsers = {};

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ username, room }) => {
    // Leave previous room if exists
    if (socket.room) {
      socket.leave(socket.room);
      removeUserFromRoom(socket);
    }

    // Join new room
    socket.join(room);
    socket.username = username;
    socket.room = room;

    // Initialize room data if doesn't exist
    if (!chatHistory[room]) chatHistory[room] = [];
    if (!activeUsers[room]) activeUsers[room] = new Set();
    if (!typingUsers[room]) typingUsers[room] = new Set();

    // Add user to active users
    activeUsers[room].add(username);

    const time = new Date().toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    // Send chat history to the joining user
    socket.emit("chat-history", chatHistory[room]);

    // Announce user joined
    const joinMsg = {
      user: "System",
      message: `${username} joined the room`,
      time,
    };
    chatHistory[room].push(joinMsg);
    
    // Keep chat history manageable (last 100 messages)
    if (chatHistory[room].length > 100) {
      chatHistory[room] = chatHistory[room].slice(-100);
    }
    
    io.to(room).emit("message", joinMsg);

    console.log(`${username} joined room: ${room}`);
  });

  // Handle user messages
  socket.on("user-message", ({ user, message }) => {
    if (!socket.room) return;

    const time = new Date().toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const msg = {
      user: user,
      message: message.trim(),
      time,
    };

    // Add to chat history
    chatHistory[socket.room].push(msg);
    
    // Keep chat history manageable
    if (chatHistory[socket.room].length > 100) {
      chatHistory[socket.room] = chatHistory[socket.room].slice(-100);
    }

    // Broadcast message to all users in the room
    io.to(socket.room).emit("message", msg);

    console.log(`Message from ${user} in ${socket.room}: ${message}`);
  });

  // Handle typing indicator
  socket.on("typing", (user) => {
    if (!socket.room) return;
    
    if (!typingUsers[socket.room]) {
      typingUsers[socket.room] = new Set();
    }
    
    typingUsers[socket.room].add(user);
    socket.to(socket.room).emit("typing", user);
  });

  // Handle stop typing
  socket.on("stop-typing", (user) => {
    if (!socket.room) return;
    
    if (typingUsers[socket.room]) {
      typingUsers[socket.room].delete(user);
    }
    
    socket.to(socket.room).emit("stop-typing", user);
  });

  // Handle leaving room explicitly
  socket.on("leave-room", () => {
    if (socket.room && socket.username) {
      const time = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      const leaveMsg = {
        user: "System",
        message: `${socket.username} left the room`,
        time,
      };
      
      chatHistory[socket.room].push(leaveMsg);
      socket.to(socket.room).emit("message", leaveMsg);
      
      removeUserFromRoom(socket);
      socket.leave(socket.room);
      
      console.log(`${socket.username} left room: ${socket.room}`);
      
      // Clear socket data
      socket.username = null;
      socket.room = null;
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    
    if (socket.username && socket.room) {
      const time = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      const leaveMsg = {
        user: "System",
        message: `${socket.username} disconnected`,
        time,
      };
      
      chatHistory[socket.room].push(leaveMsg);
      socket.to(socket.room).emit("message", leaveMsg);
      
      removeUserFromRoom(socket);
    }
  });

  // Helper function to remove user from room tracking
  function removeUserFromRoom(socket) {
    if (socket.room && socket.username) {
      // Remove from active users
      if (activeUsers[socket.room]) {
        activeUsers[socket.room].delete(socket.username);
        
        // Clean up empty room data
        if (activeUsers[socket.room].size === 0) {
          delete activeUsers[socket.room];
          delete typingUsers[socket.room];
          // Optionally clean up old chat history for empty rooms
          // delete chatHistory[socket.room];
        }
      }
      
      // Remove from typing users
      if (typingUsers[socket.room]) {
        typingUsers[socket.room].delete(socket.username);
      }
    }
  }
});

// Serve static files from public directory
app.use(express.static(path.resolve("./public")));

// Route for the main page
app.get("/", (req, res) => {
  return res.sendFile(path.resolve("./public/index.html"));
});

// Optional: API endpoint to get room statistics
app.get("/api/rooms", (req, res) => {
  const roomStats = {};
  for (const room in activeUsers) {
    roomStats[room] = {
      userCount: activeUsers[room].size,
      users: Array.from(activeUsers[room]),
      messageCount: chatHistory[room] ? chatHistory[room].length : 0
    };
  }
  res.json(roomStats);
});

// Start the server
const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`🚀 Server started at http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${path.resolve("./public")}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});