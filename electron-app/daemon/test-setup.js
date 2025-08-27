const fs = require('fs');
const path = require('path');

// Global test timeout
jest.setTimeout(10000);

// Clean up test sockets after each test
afterEach(() => {
  const testSockets = [
    '/tmp/theoldswitcheroo-test.sock',
    '/tmp/test-daemon.sock'
  ];
  
  testSockets.forEach(socketPath => {
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });
});
