export * from './enums.js';
export * from './errors.js';
export * from './question.js';
export * from './session.js';
export * from './stateMachine.js';
export * from './protocol.js';
export * from './timeSync.js';
export * from './mathShortcuts.js';

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  role: import('./enums.js').UserRole;
}

export interface AuthResponse {
  token: string;
  user: UserDTO;
}
