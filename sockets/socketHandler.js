const roomManager = require("../models/roomManager");

// Strip all HTML tags from a string to prevent chat injection
const sanitize = (str) =>
  typeof str === "string" ? str.replace(/<[^>]*>/g, "").trim() : "";

module.exports = (io, socket) => {
  console.log(`📡 Peer connection established: ${socket.id}`);

  // Server-driven sync heartbeat: runs every 4s for every controller in every room.
  // Moving this to the server fixes two issues:
  //   1. Participants who become Moderators also keep peers aligned (not just the Host).
  //   2. The Host client no longer needs a setInterval, simplifying frontend logic.
  const syncInterval = setInterval(() => {
    Object.keys(roomManager.rooms).forEach((roomId) => {
      const room = roomManager.getRoom(roomId);
      if (!room || room.playState !== "playing") return;

      // Find the first available controller (Host preferred, then first Moderator)
      const controller =
        room.participants.find((p) => p.role === "Host") ||
        room.participants.find((p) => p.role === "Moderator");

      if (controller) {
        // Broadcast a soft 'sync' to everyone except the controller
        socket.to(roomId).emit("playback_broadcast", {
          action: "sync",
          time: room.currentTime,
          sentAt: Date.now(),
        });
      }
    });
  }, 4000);

  socket.on("disconnect", () => clearInterval(syncInterval));

  // 1. CREATE ROOM (Creator becomes Host)
  socket.on("create_room", ({ roomId, username }) => {
    const cleanRoomId = roomId.toUpperCase();
    const result = roomManager.createRoom(cleanRoomId, socket.id, username);

    if (result.error) {
      socket.emit("error_message", { message: result.error });
      return;
    }

    socket.join(cleanRoomId);
    console.log(`[Room ${cleanRoomId}] Created by Host: ${username}`);

    socket.emit("room_created", {
      roomId: cleanRoomId,
      role: "Host",
      participants: result.room.participants,
    });

    socket.emit("sync_state", {
      videoId: result.room.videoId,
      playState: result.room.playState,
      currentTime: result.room.currentTime,
    });
  });

  // 2. JOIN ROOM (Joiner is ALWAYS Participant by default)
  socket.on("join_room", ({ roomId, username }) => {
    const cleanRoomId = roomId.toUpperCase();
    const result = roomManager.joinRoom(cleanRoomId, socket.id, username);

    if (result.error) {
      socket.emit("error_message", { message: result.error });
      return;
    }

    socket.join(cleanRoomId);
    console.log(`[Room ${cleanRoomId}] User joined: ${username} (Participant)`);

    socket.emit("room_joined", {
      roomId: cleanRoomId,
      role: "Participant",
      username: username,
      participants: result.room.participants,
    });

    io.to(cleanRoomId).emit("room_update", {
      participants: result.room.participants,
    });

    socket.emit("sync_state", {
      videoId: result.room.videoId,
      playState: result.room.playState,
      currentTime: result.room.currentTime,
    });
  });

  // 3. RECONNECT ROOM
  // Security fix: the client-supplied `role` is never trusted directly.
  // We look up the existing participant by username to recover their server-stored
  // role. Only if they were previously the Host do we allow that privilege to persist.
  socket.on("reconnect_room", ({ roomId, username }) => {
    const cleanRoomId = roomId.toUpperCase();
    let room = roomManager.getRoom(cleanRoomId);
    let resolvedRole;

    if (!room) {
      // Room is gone — only recreate it if this user was the original creator.
      // We can't verify that without a session store, so we expire the session.
      socket.emit("session_expired", {
        message: "The watch room has ended or no longer exists.",
      });
      return;
    }

    // Find the user's existing server-side record by username
    const existingIdx = room.participants.findIndex(
      (p) => p.username === username,
    );

    if (existingIdx !== -1) {
      // Re-use the server-stored role — ignore whatever the client claimed
      resolvedRole = room.participants[existingIdx].role;
      room.participants.splice(existingIdx, 1);
    } else {
      // New user not seen before — always join as Participant
      resolvedRole = "Participant";
    }

    room.participants.push({ id: socket.id, username, role: resolvedRole });
    socket.join(cleanRoomId);
    console.log(
      `🔄 [Room ${cleanRoomId}] User reconnected: ${username} (${resolvedRole})`,
    );

    socket.emit("room_reconnected", {
      roomId: cleanRoomId,
      role: resolvedRole,
      username,
      participants: room.participants,
      initialState: {
        videoId: room.videoId,
        playState: room.playState,
        currentTime: room.currentTime,
      },
    });

    io.to(cleanRoomId).emit("room_update", {
      participants: room.participants,
    });

    socket.emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: room.currentTime,
    });
  });

  // 4. REQUEST SYNC
  socket.on("request_sync", ({ roomId }) => {
    const cleanRoomId = roomId.toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (room) {
      socket.emit("sync_state", {
        videoId: room.videoId,
        playState: room.playState,
        currentTime: room.currentTime,
      });
    }
  });

  // 5. MEDIA PLAYBACK SYNC (Enforces Host/Moderator restrictions)
  socket.on("player_action", ({ roomId, action, time }) => {
    const cleanRoomId = roomId.toUpperCase();
    const role = roomManager.getUserRole(cleanRoomId, socket.id);

    if (role !== "Host" && role !== "Moderator") {
      const room = roomManager.getRoom(cleanRoomId);
      if (room) {
        socket.emit("sync_state", {
          videoId: room.videoId,
          playState: room.playState,
          currentTime: room.currentTime,
        });
      }
      return;
    }

    roomManager.updatePlayback(cleanRoomId, action, time);

    socket.to(cleanRoomId).emit("playback_broadcast", {
      action,
      time,
      sentAt: Date.now(),
    });
  });

  // 6. PROMOTE/DEMOTE USER ROLE (Host only)
  socket.on("promote_user", ({ roomId, targetUserId, newRole }) => {
    const cleanRoomId = roomId.toUpperCase();
    const senderRole = roomManager.getUserRole(cleanRoomId, socket.id);

    // Only the primary Host can promote or demote members
    if (senderRole !== "Host") {
      console.log(`🚫 Unauthorized promotion attempt by ${socket.id}`);
      return;
    }

    const result = roomManager.updateUserRole(
      cleanRoomId,
      targetUserId,
      newRole,
    );

    if (result.success) {
      console.log(
        `🎖️ [Room ${cleanRoomId}] User ${result.participant.username} is now ${newRole}`,
      );

      // Broadcast the updated roster to the whole room
      io.to(cleanRoomId).emit("room_update", {
        participants: result.participants,
      });

      // Notify the specific promoted user directly so their UI updates
      io.to(targetUserId).emit("role_assigned", {
        role: newRole,
      });
    }
  });

  // 7. VIDEO LINK CHANGE EVENT
  socket.on("change_video", ({ roomId, videoId }) => {
    const cleanRoomId = roomId.toUpperCase();
    const role = roomManager.getUserRole(cleanRoomId, socket.id);

    if (role !== "Host" && role !== "Moderator") return;

    roomManager.changeVideo(cleanRoomId, videoId);
    io.to(cleanRoomId).emit("video_changed", { videoId });
  });

  // 8. REAL-TIME CHAT MESSAGE FORWARDER
  // Messages are sanitized (HTML stripped) before broadcast to prevent injection.
  socket.on("send_message", ({ roomId, message }) => {
    const cleanRoomId = roomId.toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const sender = room.participants.find((p) => p.id === socket.id);
    if (!sender) return;

    const safeMessage = sanitize(message);
    if (!safeMessage) return; // Drop empty or tag-only messages

    io.to(cleanRoomId).emit("new_message", {
      username: sender.username,
      role: sender.role,
      message: safeMessage,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  });

  socket.on("remove_participant", ({ roomId, targetUserId }) => {
    const cleanRoomId = roomId.toUpperCase();
    const senderRole = roomManager.getUserRole(cleanRoomId, socket.id);

    // Only the primary Host can kick members
    if (senderRole !== "Host") {
      console.log(`🚫 Unauthorized kick attempt by ${socket.id}`);
      return;
    }

    // 1. Notify the target user that they are being kicked
    io.to(targetUserId).emit("participant_removed", { roomId: cleanRoomId });

    // 2. Remove them from the room state
    const changes = roomManager.removeParticipant(targetUserId);

    // 3. Broadcast the updated roster to the remaining users
    changes.forEach(({ roomId: rId, remainingParticipants }) => {
      io.to(cleanRoomId).emit("room_update", {
        participants: remainingParticipants,
      });
    });

    console.log(
      `🥾 [Room ${cleanRoomId}] Host kicked participant: ${targetUserId}`,
    );
  });

  // 9. DISCONNECTION & AUTO-PROMOTION HANDLER
  // Note: the syncInterval for this socket is also cleared here (registered above).
  socket.on("disconnect", () => {
    clearInterval(syncInterval);
    const changes = roomManager.removeParticipant(socket.id);

    changes.forEach(
      ({
        roomId,
        removedUser,
        newHost,
        isRoomEmpty,
        remainingParticipants,
      }) => {
        console.log(`User left [Room ${roomId}]: ${removedUser.username}`);

        if (!isRoomEmpty) {
          io.to(roomId).emit("room_update", {
            participants: remainingParticipants,
          });

          if (newHost) {
            console.log(`Auto-promoted new Host: ${newHost.username}`);
            io.to(roomId).emit("host_changed", {
              hostId: newHost.id,
              hostName: newHost.username,
            });
          }
        } else {
          console.log(`Room ${roomId} deleted (empty).`);
        }
      },
    );
  });

  // 10. PARTICIPANT CHANGE REQUEST (Forwarded to Host/Moderators)
  socket.on("request_change", ({ roomId, type, payload }) => {
    const cleanRoomId = roomId.toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const sender = room.participants.find((p) => p.id === socket.id);
    if (!sender) return;

    // Route request to users with control permissions
    const controllers = room.participants.filter(
      (p) => p.role === "Host" || p.role === "Moderator"
    );

    const requestData = {
      requestId: `${socket.id}-${Date.now()}`,
      senderId: socket.id,
      senderUsername: sender.username,
      type,
      payload,
    };

    controllers.forEach((ctrl) => {
      io.to(ctrl.id).emit("incoming_change_request", requestData);
    });
  });

  // 11. APPROVE / DECLINE CHANGE REQUEST (Host/Moderator only)
  socket.on("resolve_change_request", ({ roomId, requestId, senderId, approved, type, payload }) => {
    const cleanRoomId = roomId.toUpperCase();
    const role = roomManager.getUserRole(cleanRoomId, socket.id);

    if (role !== "Host" && role !== "Moderator") return;

    // Send decision back to the requesting participant
    io.to(senderId).emit("request_response", {
      requestId,
      approved,
      type,
      message: approved ? "Your request was approved!" : "Your request was declined by the host.",
    });

    // Apply the requested change if approved
    if (approved) {
      if (type === "change_video" && payload?.videoId) {
        roomManager.changeVideo(cleanRoomId, payload.videoId);
        io.to(cleanRoomId).emit("video_changed", { videoId: payload.videoId });
      }
    }
  });
};
