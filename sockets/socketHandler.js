const roomManager = require("../models/roomManager");

// Strip all HTML tags from a string to prevent chat injection
const sanitize = (str) =>
  typeof str === "string" ? str.replace(/<[^>]*>/g, "").trim() : "";

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

  // 3. RECONNECT ROOM (Handles Page Reload & Network Recovery)
  socket.on("reconnect_room", ({ roomId, username }) => {
    const cleanRoomId = roomId.toUpperCase();
    let room = roomManager.getRoom(cleanRoomId);

    if (!room) {
      socket.emit("session_expired", {
        message: "The watch room has ended or no longer exists.",
      });
      return;
    }

    // Cancel pending disconnect grace period timer if this user is reloading
    const timerKey = `${cleanRoomId}_${username}`;
    if (roomManager.disconnectTimers[timerKey]) {
      clearTimeout(roomManager.disconnectTimers[timerKey]);
      delete roomManager.disconnectTimers[timerKey];
    }

    // Recover existing participant or match creator username
    let participant = room.participants.find((p) => p.username === username);
    let resolvedRole;

    if (participant) {
      participant.id = socket.id;
      participant.disconnected = false;
      resolvedRole = participant.role;
    } else if (room.creatorUsername === username) {
      resolvedRole = "Host";
      participant = { id: socket.id, username, role: resolvedRole, disconnected: false };
      room.participants.unshift(participant);
    } else {
      resolvedRole = "Participant";
      participant = { id: socket.id, username, role: resolvedRole, disconnected: false };
      room.participants.push(participant);
    }

    if (resolvedRole === "Host") {
      room.creatorId = socket.id;
    }

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

    // Keep server's cached playback position fresh
    roomManager.updatePlayback(cleanRoomId, action === "sync" ? "play" : action, time);

    // Broadcast to peers (excluding the sender)
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

      io.to(cleanRoomId).emit("room_update", {
        participants: result.participants,
      });

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

    const safeMessage = sanitize(message);
    if (!safeMessage) return;

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

  // 9. REMOVE PARTICIPANT (Kick)
  socket.on("remove_participant", ({ roomId, targetUserId }) => {
    const cleanRoomId = roomId.toUpperCase();
    const senderRole = roomManager.getUserRole(cleanRoomId, socket.id);

    if (senderRole !== "Host") {
      console.log(`🚫 Unauthorized kick attempt by ${socket.id}`);
      return;
    }

    io.to(targetUserId).emit("participant_removed", { roomId: cleanRoomId });

    const changes = roomManager.removeParticipant(targetUserId);

    changes.forEach(({ remainingParticipants }) => {
      io.to(cleanRoomId).emit("room_update", {
        participants: remainingParticipants,
      });
    });

    console.log(
      `🥾 [Room ${cleanRoomId}] Host kicked participant: ${targetUserId}`,
    );
  });

  // 10. EXPLICIT LEAVE ROOM (Instant removal without grace period)
  socket.on("leave_room", ({ roomId }) => {
    const cleanRoomId = (roomId || "").toUpperCase();
    const result = roomManager.handleSocketDisconnect(socket.id);
    if (!result) return;

    const { participant } = result;
    const timerKey = `${cleanRoomId}_${participant.username}`;
    if (roomManager.disconnectTimers[timerKey]) {
      clearTimeout(roomManager.disconnectTimers[timerKey]);
      delete roomManager.disconnectTimers[timerKey];
    }

    const cleanup = roomManager.finalizeParticipantRemoval(cleanRoomId, participant.username, true);
    if (cleanup) {
      const { newHost, isRoomEmpty, remainingParticipants } = cleanup;
      if (!isRoomEmpty) {
        io.to(cleanRoomId).emit("room_update", {
          participants: remainingParticipants,
        });
        if (newHost) {
          io.to(cleanRoomId).emit("host_changed", {
            hostId: newHost.id,
            hostName: newHost.username,
          });
        }
      }
    }
  });

  // 11. DISCONNECTION HANDLER (With 15-second Grace Period for Page Reloads)
  socket.on("disconnect", () => {
    const result = roomManager.handleSocketDisconnect(socket.id);
    if (!result) return;

    const { roomId, participant } = result;
    console.log(
      `⏳ [Room ${roomId}] User disconnected (grace period started): ${participant.username} (${participant.role})`,
    );

    const timerKey = `${roomId}_${participant.username}`;
    if (roomManager.disconnectTimers[timerKey]) {
      clearTimeout(roomManager.disconnectTimers[timerKey]);
    }

    // 15-second grace period for reload or reconnect
    roomManager.disconnectTimers[timerKey] = setTimeout(() => {
      delete roomManager.disconnectTimers[timerKey];
      const cleanup = roomManager.finalizeParticipantRemoval(roomId, participant.username);
      if (!cleanup) return;

      const { newHost, isRoomEmpty, remainingParticipants } = cleanup;
      console.log(`🚪 [Room ${roomId}] Grace period expired for: ${participant.username}`);

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
        console.log(`Room ${roomId} deleted (empty after grace period).`);
      }
    }, 15000);
  });

  // 12. PARTICIPANT CHANGE REQUEST (Forwarded to Host/Moderators)
  socket.on("request_change", ({ roomId, type, payload }) => {
    const cleanRoomId = roomId.toUpperCase();
    const room = roomManager.getRoom(cleanRoomId);
    if (!room) return;

    const sender = room.participants.find((p) => p.id === socket.id);
    if (!sender) return;

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

  // 13. APPROVE / DECLINE CHANGE REQUEST (Host/Moderator only)
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
