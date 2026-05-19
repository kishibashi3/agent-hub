import type { Database } from 'better-sqlite3';
import * as P from './participants.js';
import * as M from './messages.js';
import * as T from './teams.js';
import type {
  Participant,
  PeerMode,
  RegisterInput,
  Message,
  SendMessageInput,
  GetHistoryInput,
  Team,
  CreateTeamInput,
  UpdateTeamInput,
} from '../types/schema.js';

/**
 * tenant scoped DB ハンドル。
 *
 * 全 db 操作を `tenantId` 固定で wrap し、handler 側からは tenant_id を
 * 意識しない API を提供する。「forever-tax (WHERE tenant_id 忘れ)」を
 * この 1 ファイルに閉じ込めることで、handler / tools 側のロジックは
 * 単一 tenant 時と同じコード構造で書ける。
 */
export interface TenantScope {
  readonly tenantId: string;
  readonly db: Database;

  // participants
  registerParticipant(input: RegisterInput, owner: string | null): Participant;
  updateParticipantMode(name: string, mode: PeerMode | null): void;
  updateParticipantDisplayName(name: string, displayName: string | null): void;
  claimOwnerIfUnowned(name: string, owner: string): boolean;
  getParticipants(): Participant[];
  getParticipantByName(name: string): Participant | null;
  getParticipantByNameIncludingDeleted(name: string): Participant | null;
  softDeleteParticipant(name: string): boolean;
  reviveParticipant(name: string, owner: string): boolean;
  updateLastActiveAt(name: string): void;

  // messages
  sendMessage(input: SendMessageInput, sender: string): Message;
  getMessage(messageId: string, requester: string): Message;
  getUnreadMessages(reader: string): Message[];
  getHistory(input: GetHistoryInput, requester: string): Message[];
  markAsRead(messageId: string, reader: string): { read: true };

  // teams
  createTeam(input: CreateTeamInput, requester: string): Team;
  updateTeam(
    input: UpdateTeamInput,
    requester: string
  ): { name: string; members: string[] };
  deleteTeam(teamName: string, requester: string): { deleted: true };
  getTeams(): Team[];
  getTeamMembers(teamName: string): string[];
  isTeamMember(teamName: string, memberName: string): boolean;
}

export function scopeToTenant(db: Database, tenantId: string): TenantScope {
  return {
    tenantId,
    db,

    // participants
    registerParticipant: (input, owner) =>
      P.registerParticipant(db, tenantId, input, owner),
    updateParticipantMode: (name, mode) =>
      P.updateParticipantMode(db, tenantId, name, mode),
    updateParticipantDisplayName: (name, displayName) =>
      P.updateParticipantDisplayName(db, tenantId, name, displayName),
    claimOwnerIfUnowned: (name, owner) =>
      P.claimOwnerIfUnowned(db, tenantId, name, owner),
    getParticipants: () => P.getParticipants(db, tenantId),
    getParticipantByName: (name) => P.getParticipantByName(db, tenantId, name),
    getParticipantByNameIncludingDeleted: (name) =>
      P.getParticipantByNameIncludingDeleted(db, tenantId, name),
    softDeleteParticipant: (name) =>
      P.softDeleteParticipant(db, tenantId, name),
    reviveParticipant: (name, owner) =>
      P.reviveParticipant(db, tenantId, name, owner),
    updateLastActiveAt: (name) => P.updateLastActiveAt(db, tenantId, name),

    // messages
    sendMessage: (input, sender) => M.sendMessage(db, tenantId, input, sender),
    getMessage: (messageId, requester) =>
      M.getMessage(db, tenantId, messageId, requester),
    getUnreadMessages: (reader) => M.getUnreadMessages(db, tenantId, reader),
    getHistory: (input, requester) =>
      M.getHistory(db, tenantId, input, requester),
    markAsRead: (messageId, reader) =>
      M.markAsRead(db, tenantId, messageId, reader),

    // teams
    createTeam: (input, requester) => T.createTeam(db, tenantId, input, requester),
    updateTeam: (input, requester) => T.updateTeam(db, tenantId, input, requester),
    deleteTeam: (teamName, requester) =>
      T.deleteTeam(db, tenantId, teamName, requester),
    getTeams: () => T.getTeams(db, tenantId),
    getTeamMembers: (teamName) => T.getTeamMembers(db, tenantId, teamName),
    isTeamMember: (teamName, memberName) =>
      T.isTeamMember(db, tenantId, teamName, memberName),
  };
}
