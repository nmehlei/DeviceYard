module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  modulePathIgnorePatterns: ["<rootDir>/.claude/worktrees/", "<rootDir>/.worktrees/", "<rootDir>/.edition-builds/"],
  testMatch: ["<rootDir>/tests/**/*.test.ts", "<rootDir>/cli/tests/**/*.test.ts"],
  // Fails a test when the HOST ran out of disk/handles/memory underneath it,
  // instead of letting the suite report green over a meaningless run.
  setupFilesAfterEnv: ["<rootDir>/tests/helpers/hostHealth.ts", "<rootDir>/tests/helpers/skipProfileCleanup.ts"],
  moduleNameMapper: {
    "^@modelcontextprotocol/sdk/(.*)$": "<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/$1",
  },
};
