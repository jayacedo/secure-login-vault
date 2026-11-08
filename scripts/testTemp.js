// Where the tests keep their throwaway data: a git-ignored .tmp folder inside the
// project, never the user's system temp folder.
const fs = require("fs");
const path = require("path");

const TEST_TEMP_ROOT = path.join(__dirname, "..", ".tmp");

function testTempRoot() {
  fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  return TEST_TEMP_ROOT;
}

module.exports = { testTempRoot };
