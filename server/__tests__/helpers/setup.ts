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
  // #6 email-in auto-acknowledgement template — inboundEmail.ts imports this.
  reportReceivedHtml:      jest.fn().mockReturnValue('<p>received</p>'),
}));

export {};
