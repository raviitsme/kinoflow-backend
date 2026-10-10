const roomManager = require("../models/roomManager");

module.exports = (io, socket) => {
  console.log(`📡 Peer connection established: ${socket.id}`);

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
  socket.on("reconnect_room", ({ roomId, username, role }) => {
    const cleanRoomId = roomId.toUpperCase();
    let room = roomManager.getRoom(cleanRoomId);

    if (!room) {
      if (role === "Host") {
        const result = roomManager.createRoom(cleanRoomId, socket.id, username);
        room = result.room;
      } else {
        socket.emit("session_expired", {
          message: "The watch room has ended or no longer exists.",
        });
        return;
      }
    } else {
      const existingIdx = room.participants.findIndex(
        (p) => p.username === username,
      );
      if (existingIdx !== -1) {
        room.participants.splice(existingIdx, 1);
      }

      let assignedRole = role;
      if (role === "Host") {
        room.participants.forEach((p) => {
          p.role = "Participant";
        });
        assignedRole = "Host";
      }

      room.participants.push({ id: socket.id, username, role: assignedRole });
    }

    socket.join(cleanRoomId);
    console.log(
      `🔄 [Room ${cleanRoomId}] User reconnected: ${username} (${role})`,
    );

    const currentParticipant = room.participants.find(
      (p) => p.id === socket.id,
    );
    const resolvedRole = currentParticipant ? currentParticipant.role : role;

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

  // 6. ✅ CORRECTED: Un-nested "promote_user" event listener (Registered at root level)
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
  socket.on("send_message", ({ roomId, message }) => {
    const cleanRoomId = roomId.toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const sender = room.participants.find((p) => p.id === socket.id);
    if (!sender) return;

    io.to(cleanRoomId).emit("new_message", {
      username: sender.username,
      role: sender.role,
      message,
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
  socket.on("disconnect", () => {
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
};
