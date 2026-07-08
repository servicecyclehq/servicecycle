/**
 * Post-framework test setup (jest setupFilesAfterEnv).
 * jest.mock() is available here.
 */

// Mock email so no real sends happen during tests
jest.mock('../../lib/email', () => ({
  sendEmail:               jest.fn().mockResolvedValue({ messageId: 'test-message-id' }),
  passwordResetHtml:       jest.fn().mockReturnValue('<p>reset</p>'),
  inviteHtml:              jest.fn().mockReturnValue('<p>invite</p>'),
  newViewerActivationHtml: jest.fn().mockReturnValue('<p>activate</p>'),
  welcomeHtml:             jest.fn().mockReturnValue('<p>welcome</p>'),
  // #6 email-in acknowledgement templates.
  reportReceivedHtml:      jest.fn().mockReturnValue('<p>received</p>'),
  reportProcessedHtml:     jest.fn().mockReturnValue('<p>processed</p>'),
  reportNeedsReviewHtml:   jest.fn().mockReturnValue('<p>needs review</p>'),
  // L7 early-access lead-capture templates (2026-07-08: added — routes/earlyAccess.ts
  // calls these synchronously while building the sendEmail() args; a missing mock
  // export here isn't a harmless no-op jest.fn(), it's `undefined` and throws
  // "X is not a function" INSIDE an un-try/caught async handler, which hangs the
  // request until the test's timeout fires instead of failing fast).
  earlyAccessReplyHtml:        jest.fn().mockReturnValue('<p>early access reply</p>'),
  earlyAccessNotificationHtml: jest.fn().mockReturnValue('<p>early access notification</p>'),
}));

export {};
