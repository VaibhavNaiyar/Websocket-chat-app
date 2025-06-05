const http = require("http");
const express = require("express");
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store chat history, active users, and typing status
const chatHistory = {};
const activeUsers = {};
const typingUsers = {};
const userSockets = {}; // Track socket IDs by username

// Configuration
const MAX_MESSAGES_PER_ROOM = 100;
const MAX_USERNAME_LENGTH = 20;
const MAX_ROOM_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;
const TYPING_TIMEOUT = 3000; // 3 seconds

io.on("connection", (socket) => {
  console.log(`🔗 User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ username, room }) => {
    try {
      // Validate input
      if (!username || !room || 
          username.trim().length === 0 || 
          room.trim().length === 0 ||
          username.length > MAX_USERNAME_LENGTH ||
          room.length > MAX_ROOM_LENGTH) {
        socket.emit("error", { message: "Invalid username or room name" });
        return;
      }

      const trimmedUsername = username.trim();
      const trimmedRoom = room.trim();

      // Leave previous room if exists
      if (socket.room) {
        socket.leave(socket.room);
        removeUserFromRoom(socket);
      }

      // Check if username is already taken in this room
      if (activeUsers[trimmedRoom] && activeUsers[trimmedRoom].has(trimmedUsername)) {
        socket.emit("error", { message: "Username already taken in this room" });
        return;
      }

      // Join new room
      socket.join(trimmedRoom);
      socket.username = trimmedUsername;
      socket.room = trimmedRoom;

      // Initialize room data if doesn't exist
      if (!chatHistory[trimmedRoom]) chatHistory[trimmedRoom] = [];
      if (!activeUsers[trimmedRoom]) activeUsers[trimmedRoom] = new Set();
      if (!typingUsers[trimmedRoom]) typingUsers[trimmedRoom] = new Map();

      // Add user to active users and track socket
      activeUsers[trimmedRoom].add(trimmedUsername);
      userSockets[socket.id] = { username: trimmedUsername, room: trimmedRoom };

      const time = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });

      // Send chat history to the joining user
      socket.emit("chat-history", chatHistory[trimmedRoom]);

      // Send current active users list
      socket.emit("active-users", Array.from(activeUsers[trimmedRoom]));

      // Announce user joined to others in the room
      const joinMsg = {
        user: "System",
        message: `${trimmedUsername} joined the room`,
        time,
        type: "join"
      };
      
      // Add to chat history
      chatHistory[trimmedRoom].push(joinMsg);
      
      // Keep chat history manageable
      if (chatHistory[trimmedRoom].length > MAX_MESSAGES_PER_ROOM) {
        chatHistory[trimmedRoom] = chatHistory[trimmedRoom].slice(-MAX_MESSAGES_PER_ROOM);
      }
      
      // Broadcast to all users in room (including the joiner)
      io.to(trimmedRoom).emit("message", joinMsg);

      // Update user count for all users in room
      io.to(trimmedRoom).emit("user-count", activeUsers[trimmedRoom].size);

      console.log(`👤 ${trimmedUsername} joined room: ${trimmedRoom} (${activeUsers[trimmedRoom].size} users)`);

    } catch (error) {
      console.error("Error in join-room:", error);
      socket.emit("error", { message: "Failed to join room" });
    }
  });

  // Handle user messages
  socket.on("user-message", ({ user, message }) => {
    try {
      if (!socket.room || !socket.username) {
        socket.emit("error", { message: "You must join a room first" });
        return;
      }

      // Validate message
      if (!message || message.trim().length === 0) {
        return;
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        socket.emit("error", { message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` });
        return;
      }

      // Verify user matches socket
      if (user !== socket.username) {
        socket.emit("error", { message: "Username mismatch" });
        return;
      }

      const time = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
      
      const msg = {
        user: user,
        message: message.trim(),
        time,
        type: "message",
        id: Date.now() + Math.random() // Simple message ID
      };

      // Add to chat history
      chatHistory[socket.room].push(msg);
      
      // Keep chat history manageable
      if (chatHistory[socket.room].length > MAX_MESSAGES_PER_ROOM) {
        chatHistory[socket.room] = chatHistory[socket.room].slice(-MAX_MESSAGES_PER_ROOM);
      }

      // Broadcast message to all users in the room
      io.to(socket.room).emit("message", msg);

      console.log(`💬 Message from ${user} in ${socket.room}: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);

    } catch (error) {
      console.error("Error in user-message:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // Handle typing indicator
  socket.on("typing", (user) => {
    try {
      if (!socket.room || !socket.username || user !== socket.username) return;
      
      if (!typingUsers[socket.room]) {
        typingUsers[socket.room] = new Map();
      }
      
      // Clear existing timeout for this user
      if (typingUsers[socket.room].has(user)) {
        clearTimeout(typingUsers[socket.room].get(user));
      }
      
      // Set new timeout
      const timeout = setTimeout(() => {
        typingUsers[socket.room].delete(user);
        socket.to(socket.room).emit("stop-typing", user);
      }, TYPING_TIMEOUT);
      
      typingUsers[socket.room].set(user, timeout);
      socket.to(socket.room).emit("typing", user);

    } catch (error) {
      console.error("Error in typing:", error);
    }
  });

  // Handle stop typing
  socket.on("stop-typing", (user) => {
    try {
      if (!socket.room || !socket.username || user !== socket.username) return;
      
      if (typingUsers[socket.room] && typingUsers[socket.room].has(user)) {
        clearTimeout(typingUsers[socket.room].get(user));
        typingUsers[socket.room].delete(user);
      }
      
      socket.to(socket.room).emit("stop-typing", user);

    } catch (error) {
      console.error("Error in stop-typing:", error);
    }
  });

  // Handle leaving room explicitly
  socket.on("leave-room", () => {
    try {
      handleUserLeave(socket, "left the room");
    } catch (error) {
      console.error("Error in leave-room:", error);
    }
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    console.log(`🔌 User disconnected: ${socket.id} (${reason})`);
    
    try {
      handleUserLeave(socket, "disconnected");
    } catch (error) {
      console.error("Error in disconnect:", error);
    }
  });

  // Handle user requesting active users list
  socket.on("get-active-users", () => {
    if (socket.room && activeUsers[socket.room]) {
      socket.emit("active-users", Array.from(activeUsers[socket.room]));
    }
  });

  // Helper function to handle user leaving
  function handleUserLeave(socket, action = "left the room") {
    if (socket.username && socket.room) {
      const time = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
      
      const leaveMsg = {
        user: "System",
        message: `${socket.username} ${action}`,
        time,
        type: "leave"
      };
      
      // Add to chat history
      if (chatHistory[socket.room]) {
        chatHistory[socket.room].push(leaveMsg);
        
        // Keep chat history manageable
        if (chatHistory[socket.room].length > MAX_MESSAGES_PER_ROOM) {
          chatHistory[socket.room] = chatHistory[socket.room].slice(-MAX_MESSAGES_PER_ROOM);
        }
      }
      
      // Broadcast leave message to others in room
      socket.to(socket.room).emit("message", leaveMsg);
      
      // Remove user from room tracking
      removeUserFromRoom(socket);
      
      // Update user count for remaining users
      if (activeUsers[socket.room]) {
        io.to(socket.room).emit("user-count", activeUsers[socket.room].size);
      }
      
      console.log(`👋 ${socket.username} ${action}: ${socket.room}`);
      
      // Leave the room
      socket.leave(socket.room);
      
      // Clear socket data
      socket.username = null;
      socket.room = null;
    }
    
    // Clean up socket tracking
    delete userSockets[socket.id];
  }

  // Helper function to remove user from room tracking
  function removeUserFromRoom(socket) {
    if (socket.room && socket.username) {
      // Remove from active users
      if (activeUsers[socket.room]) {
        activeUsers[socket.room].delete(socket.username);
        
        // Clean up empty room data
        if (activeUsers[socket.room].size === 0) {
          console.log(`🧹 Cleaning up empty room: ${socket.room}`);
          delete activeUsers[socket.room];
          
          // Clean up typing users
          if (typingUsers[socket.room]) {
            // Clear all timeouts
            for (const timeout of typingUsers[socket.room].values()) {
              clearTimeout(timeout);
            }
            delete typingUsers[socket.room];
          }
          
          // Optionally clean up old chat history for empty rooms after some time
          setTimeout(() => {
            if (!activeUsers[socket.room] || activeUsers[socket.room].size === 0) {
              delete chatHistory[socket.room];
              console.log(`🗑️ Cleaned up chat history for empty room: ${socket.room}`);
            }
          }, 300000); // 5 minutes
        }
      }
      
      // Remove from typing users
      if (typingUsers[socket.room] && typingUsers[socket.room].has(socket.username)) {
        clearTimeout(typingUsers[socket.room].get(socket.username));
        typingUsers[socket.room].delete(socket.username);
      }
    }
  }
});

// Middleware for JSON parsing
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.resolve("./public")));

// Route for the main page
app.get("/", (req, res) => {
  return res.sendFile(path.resolve("./public/index.html"));
});

// API endpoint to get room statistics
app.get("/api/rooms", (req, res) => {
  try {
    const roomStats = {};
    for (const room in activeUsers) {
      roomStats[room] = {
        userCount: activeUsers[room].size,
        users: Array.from(activeUsers[room]),
        messageCount: chatHistory[room] ? chatHistory[room].length : 0,
        lastActivity: chatHistory[room] && chatHistory[room].length > 0 
          ? chatHistory[room][chatHistory[room].length - 1].time 
          : null
      };
    }
    res.json({
      totalRooms: Object.keys(roomStats).length,
      totalUsers: Object.values(activeUsers).reduce((sum, users) => sum + users.size, 0),
      rooms: roomStats
    });
  } catch (error) {
    console.error("Error in /api/rooms:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API endpoint to get specific room info
app.get("/api/rooms/:roomName", (req, res) => {
  try {
    const roomName = req.params.roomName;
    if (activeUsers[roomName]) {
      res.json({
        room: roomName,
        userCount: activeUsers[roomName].size,
        users: Array.from(activeUsers[roomName]),
        messageCount: chatHistory[roomName] ? chatHistory[roomName].length : 0,
        recentMessages: chatHistory[roomName] ? chatHistory[roomName].slice(-10) : []
      });
    } else {
      res.status(404).json({ error: "Room not found or empty" });
    }
  } catch (error) {
    console.error("Error in /api/rooms/:roomName:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeRooms: Object.keys(activeUsers).length,
    totalUsers: Object.values(activeUsers).reduce((sum, users) => sum + users.size, 0)
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Start the server
const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`🚀 ChatHub Server started at http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${path.resolve("./public")}`);
  console.log(`📊 API endpoints available at:`);
  console.log(`   - GET /api/rooms - Room statistics`);
  console.log(`   - GET /api/rooms/:roomName - Specific room info`);
  console.log(`   - GET /health - Health check`);
});

// Periodic cleanup of old data
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  
  // Clean up rooms that have been empty for more than 1 hour
  for (const room in chatHistory) {
    if (!activeUsers[room] || activeUsers[room].size === 0) {
      const lastMessage = chatHistory[room][chatHistory[room].length - 1];
      if (lastMessage && (now - new Date(lastMessage.time).getTime()) > 3600000) { // 1 hour
        delete chatHistory[room];
        cleanedRooms++;
      }
    }
  }
  
  if (cleanedRooms > 0) {
    console.log(`🧹 Cleaned up ${cleanedRooms} inactive room(s)`);
  }
}, 1800000); // Run every 30 minutes

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(' SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log(' Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log(' SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log(' Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(' Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(' Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});