/**
 * ⚡ KinoFlow Socket Handler Integration Test
 * Simulates a Host and Participant connecting to a live server.
 * Run your server first: node server.js
 * In a separate terminal run: node test-sockets.js
 */
const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:5000';
const ROOM_ID = 'TESTROOM';

console.log("⚡ INITIATING KINOFLOW SOCKET INTEGRATION TESTS...\n");

// Establish Socket Connection for the Host (Alex)
const hostSocket = io(SERVER_URL);
// Establish Socket Connection for the Participant (Ravi)
const guestSocket = io(SERVER_URL);

// Helper state tracker to verify counts
let testsPassed = 0;

// ----------------------------------------------------
// 👑 HOST WORKFLOW (Alex)
// ----------------------------------------------------
hostSocket.on('connect', () => {
  console.log("📡 Host (Alex) connected to WebSocket server.");
  
  // 🍿 Alex sends request to create the room
  hostSocket.emit('create_room', { roomId: ROOM_ID, username: 'Alex' });
});

hostSocket.on('room_created', (data) => {
  console.log(`✅ [TEST 1 PASSED] Room Created successfully!`);
  console.log(`👑 Assigned Host Role: ${data.role}`);
  console.log(`📍 Room Code: ${data.roomId}\n`);
  testsPassed++;

  // Now that the room is established, invite Ravi to join
  triggerParticipantJoin();
});

// ----------------------------------------------------
// 🎟️ PARTICIPANT WORKFLOW (Ravi)
// ----------------------------------------------------
function triggerParticipantJoin() {
  console.log("📡 Participant (Ravi) is attempting to join...");
  guestSocket.emit('join_room', { roomId: ROOM_ID, username: 'Ravi' });
}

guestSocket.on('room_joined', (data) => {
  console.log(`✅ [TEST 2 PASSED] Participant joined room!`);
  console.log(`🎟️ Assigned Guest Role: ${data.role}\n`);
  testsPassed++;
});

// Listen for roster updates
hostSocket.on('room_update', (data) => {
  if (data.participants.length === 2) {
    console.log(`✅ [TEST 3 PASSED] Room Roster updated in real-time!`);
    console.log(`👥 Active Users:`, data.participants.map(p => `${p.username} (${p.role})`).join(', '), '\n');
    testsPassed++;

    // Trigger Playback Test
    triggerPlaybackAction();
  }
});

// ----------------------------------------------------
// 🎛️ PLAYBACK SYNC TESTING
// ----------------------------------------------------
function triggerPlaybackAction() {
  console.log("🎬 Host (Alex) plays the movie at 90 seconds...");
  hostSocket.emit('player_action', { roomId: ROOM_ID, action: 'play', time: 90 });
}

// Ravi listens for Alex's playback signal
guestSocket.on('playback_broadcast', (data) => {
  console.log(`✅ [TEST 4 PASSED] Real-time Sync Broadcast received by Participant!`);
  console.log(`▶️ Received Event: "${data.action}" at timestamp: ${data.time}s\n`);
  testsPassed++;

  // Now, test the Security Guard! (Ravi attempts to pause without authorization)
  triggerSecurityBreachTest();
});

// ----------------------------------------------------
// 🛡️ SECURITY GUARD TESTING
// ----------------------------------------------------
function triggerSecurityBreachTest() {
  console.log("⚠️ Security Test: Participant (Ravi) tries to pause the video illegally...");
  guestSocket.emit('player_action', { roomId: ROOM_ID, action: 'pause', time: 10 });
}

// If Ravi tries to do an action, the server should reject it and emit 'sync_state' back to him to override his controls
guestSocket.on('sync_state', (data) => {
  // If Ravi receives a sync_state (pointing back to Alex's 90s play-time) after trying to pause at 10s:
  if (data.playState === 'playing' && data.currentTime === 90) {
    console.log(`✅ [TEST 5 PASSED] Server-Side Role Enforcement is working!`);
    console.log(`🚫 Ravi's unauthorized action was blocked.`);
    console.log(`🔄 Server forced Ravi's player back to Host state: "${data.playState}" at ${data.currentTime}s\n`);
    testsPassed++;

    // Terminate tests gracefully
    endTests();
  }
});

// ----------------------------------------------------
// 🏁 TEST TERMINATION
// ----------------------------------------------------
function endTests() {
  console.log("-----------------------------------------");
  console.log(`🏆 ALL ${testsPassed}/5 WEB SOCKET INTEGRATION TESTS COMPLETED SUCCESSFULLY!`);
  console.log("-----------------------------------------");
  
  hostSocket.disconnect();
  guestSocket.disconnect();
  process.exit(0);
}
