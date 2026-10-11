/**
 * Room Manager : Manages active watch parties, roles, playback and in-state memory
 */

class RoomManager {
  constructor() {
    this.rooms = {};
    this.disconnectTimers = {}; // Key: `${roomId}_${username}` -> setTimeout ID
  }

  // Create a new room (creator will be the host!)
  createRoom(roomId, socketId, username) {
    if (this.rooms[roomId]) {
      return {
        error: "Room already exists",
      };
    }

    const host = { id: socketId, username, role: "Host", disconnected: false };

    this.rooms[roomId] = {
      creatorId: socketId,
      creatorUsername: username,
      videoId: "LXb3EKWsInQ",
      playState: "paused",
      currentTime: 0,
      participants: [host],
    };
    return { room: this.rooms[roomId], participant: host };
  }

  // Join an existing room
  joinRoom(roomId, socketId, username) {
    const room = this.rooms[roomId];

    if (!room) {
      return {
        error: "Room doesn't exists!",
      };
    }

    const participant = { id: socketId, username, role: "Participant", disconnected: false };
    room.participants.push(participant);

    return { room, participant };
  }

  getRoom(roomId) {
    return this.rooms[roomId] || null;
  }

  getUserRole(roomId, socketId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    const user = room.participants.find((p) => p.id === socketId);
    return user ? user.role : null;
  }

  updatePlayback(roomId, action, time) {
    const room = this.getRoom(roomId);
    if (!room) return false;

    if (action === "play") room.playState = "playing";
    if (action === "pause") room.playState = "paused";
    room.currentTime = time;
    return true;
  }

  updateUserRole(roomId, targetSocketId, newRole) {
    const room = this.getRoom(roomId);
    if (!room) return { error: "Room not found" };

    const participant = room.participants.find((p) => p.id === targetSocketId);
    if (!participant) return { error: "Participant not found" };

    participant.role = newRole;
    return { success: true, participant, participants: room.participants };
  }

  changeVideo(roomId, videoId) {
    const room = this.getRoom(roomId);
    if (!room) return false;

    room.videoId = videoId;
    room.playState = "paused";
    room.currentTime = 0;
    return true;
  }

  // Marks a socket as temporarily disconnected when network or page reload occurs
  handleSocketDisconnect(socketId) {
    for (const roomId of Object.keys(this.rooms)) {
      const room = this.rooms[roomId];
      const participant = room.participants.find((p) => p.id === socketId);
      if (participant) {
        participant.disconnected = true;
        return { roomId, participant, room };
      }
    }
    return null;
  }

  // Permanently cleans up a participant when grace period expires or when explicitly leaving
  finalizeParticipantRemoval(roomId, username, force = false) {
    const room = this.rooms[roomId];
    if (!room) return null;

    const index = room.participants.findIndex((p) => p.username === username);
    if (index === -1) return null;

    const participant = room.participants[index];
    // If user reconnected in the meantime and this wasn't a forced removal, don't remove
    if (!participant.disconnected && !force) return null;

    const [removedUser] = room.participants.splice(index, 1);
    let newHost = null;

    // If host left, auto-promote next available active participant
    if (removedUser.role === "Host" && room.participants.length > 0) {
      // Prefer an active participant who is not disconnected
      const candidate = room.participants.find((p) => !p.disconnected) || room.participants[0];
      candidate.role = "Host";
      newHost = candidate;
      room.creatorId = candidate.id;
    }

    const isRoomEmpty = room.participants.length === 0;
    if (isRoomEmpty) {
      delete this.rooms[roomId];
    }

    return {
      roomId,
      removedUser,
      newHost,
      isRoomEmpty,
      remainingParticipants: room.participants,
    };
  }

  // Immediate removal (e.g. Host kick)
  removeParticipant(socketId) {
    const changes = [];

    Object.keys(this.rooms).forEach((roomId) => {
      const room = this.rooms[roomId];
      const index = room.participants.findIndex((p) => p.id === socketId);

      if (index !== -1) {
        const [removedUser] = room.participants.splice(index, 1);
        let newHost = null;

        if (removedUser.role === "Host" && room.participants.length > 0) {
          room.participants[0].role = "Host";
          newHost = room.participants[0];
        }

        const isRoomEmpty = room.participants.length === 0;
        if (isRoomEmpty) {
          delete this.rooms[roomId];
        }

        changes.push({
          roomId,
          removedUser,
          newHost,
          isRoomEmpty,
          remainingParticipants: room.participants,
        });
      }
    });
    return changes;
  }
}

module.exports = new RoomManager();
