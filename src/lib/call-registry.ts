export type CallType = "AUDIO" | "VIDEO";
export type CallMode = "ONE_TO_ONE" | "GROUP";
export type CallSignalType = "offer" | "answer" | "ice";

export type CallUser = {
  id: string;
  name: string;
  image: string | null;
};

export type CallParticipant = CallUser & {
  joinedAt: number;
};

export type CallSnapshot = {
  id: string;
  conversationId: string;
  conversationName: string;
  callType: CallType;
  mode: CallMode;
  status: "ringing" | "active";
  caller: CallUser;
  participants: CallParticipant[];
  pendingUserIds: string[];
  startedAt: number;
};

type CallRecord = {
  id: string;
  conversationId: string;
  conversationName: string;
  callType: CallType;
  mode: CallMode;
  status: "ringing" | "active";
  caller: CallUser;
  participants: Map<string, CallParticipant>;
  pendingUsers: Map<string, CallUser>;
  startedAt: number;
  expiresAt: number;
};

export class CallRegistryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CALL_NOT_FOUND"
      | "CALL_BUSY"
      | "CALL_FULL"
      | "NOT_INVITED"
      | "INVALID_STATE"
      | "NOT_CALLER"
      | "NOT_PARTICIPANT"
      | "INVALID_RECIPIENT",
  ) {
    super(message);
    this.name = "CallRegistryError";
  }
}

export class CallRegistry {
  private readonly calls = new Map<string, CallRecord>();
  private readonly callByUser = new Map<string, string>();

  create(input: {
    id: string;
    conversationId: string;
    conversationName: string;
    callType: CallType;
    mode: CallMode;
    caller: CallUser;
    invitees: CallUser[];
    now?: number;
  }): CallSnapshot {
    const now = input.now ?? Date.now();
    const invitees = [...new Map(input.invitees.map((user) => [user.id, user])).values()]
      .filter((user) => user.id !== input.caller.id);

    if (this.callByUser.has(input.caller.id)) {
      throw new CallRegistryError("You are already in a call.", "CALL_BUSY");
    }
    if (invitees.some((user) => this.callByUser.has(user.id))) {
      throw new CallRegistryError("A participant is already in another call.", "CALL_BUSY");
    }
    if (invitees.length + 1 > 8) {
      throw new CallRegistryError("A call can have up to 8 participants.", "CALL_FULL");
    }
    if (input.mode === "ONE_TO_ONE" && invitees.length !== 1) {
      throw new CallRegistryError("A private call must have one recipient.", "INVALID_RECIPIENT");
    }
    if (invitees.length === 0) {
      throw new CallRegistryError("No available participants to call.", "INVALID_RECIPIENT");
    }

    const call: CallRecord = {
      id: input.id,
      conversationId: input.conversationId,
      conversationName: input.conversationName,
      callType: input.callType,
      mode: input.mode,
      status: "ringing",
      caller: input.caller,
      participants: new Map([
        [input.caller.id, { ...input.caller, joinedAt: now }],
      ]),
      pendingUsers: new Map(invitees.map((user) => [user.id, user])),
      startedAt: now,
      expiresAt: now + 60_000,
    };

    this.calls.set(call.id, call);
    this.callByUser.set(input.caller.id, call.id);
    for (const invitee of invitees) this.callByUser.set(invitee.id, call.id);
    return this.snapshot(call);
  }

  get(callId: string): CallSnapshot {
    return this.snapshot(this.requireCall(callId));
  }

  activeCallForUser(userId: string) {
    const callId = this.callByUser.get(userId);
    return callId ? this.calls.get(callId)?.id ?? null : null;
  }

  accept(callId: string, userId: string, now = Date.now()): CallSnapshot {
    const call = this.requireCall(callId);
    if (call.status === "ringing" && call.expiresAt <= now) {
      this.removeCall(call);
      throw new CallRegistryError("This call invitation has expired.", "INVALID_STATE");
    }
    const invitee = call.pendingUsers.get(userId);
    if (!invitee) {
      throw new CallRegistryError("You are not invited to this call.", "NOT_INVITED");
    }
    if (call.participants.size >= 8) {
      this.removePending(call, userId);
      throw new CallRegistryError("This call is full.", "CALL_FULL");
    }

    const firstParticipantAccepted = call.status === "ringing";
    call.pendingUsers.delete(userId);
    call.participants.set(userId, { ...invitee, joinedAt: now });
    call.status = "active";
    if (firstParticipantAccepted) call.startedAt = now;
    return this.snapshot(call);
  }

  reject(callId: string, userId: string): {
    call: CallSnapshot;
    ended: boolean;
  } {
    const call = this.requireCall(callId);
    if (!call.pendingUsers.has(userId)) {
      throw new CallRegistryError("You are not invited to this call.", "NOT_INVITED");
    }
    this.removePending(call, userId);
    const ended = call.pendingUsers.size === 0 && call.participants.size === 1;
    if (ended) this.removeCall(call);
    return { call: this.snapshot(call), ended };
  }

  cancel(callId: string, userId: string): CallSnapshot {
    const call = this.requireCall(callId);
    if (call.caller.id !== userId) {
      throw new CallRegistryError("Only the caller can cancel an invitation.", "NOT_CALLER");
    }
    if (call.participants.size !== 1) {
      throw new CallRegistryError("The call has already been accepted.", "INVALID_STATE");
    }
    this.removeCall(call);
    return this.snapshot(call);
  }

  leave(callId: string, userId: string): {
    call: CallSnapshot;
    ended: boolean;
  } {
    const call = this.requireCall(callId);
    if (!call.participants.has(userId)) {
      throw new CallRegistryError("You are not in this call.", "NOT_PARTICIPANT");
    }

    call.participants.delete(userId);
    this.callByUser.delete(userId);
    const ended =
      call.participants.size === 0 ||
      (call.participants.size === 1 && call.pendingUsers.size === 0);
    if (ended) {
      this.removeCall(call);
    } else if (call.caller.id === userId && call.participants.size === 0) {
      this.removeCall(call);
    }
    return { call: this.snapshot(call), ended };
  }

  validateSignal(callId: string, fromUserId: string, toUserId: string): CallSnapshot {
    const call = this.requireCall(callId);
    if (fromUserId === toUserId || !call.participants.has(fromUserId)) {
      throw new CallRegistryError("You are not an active call participant.", "NOT_PARTICIPANT");
    }
    if (!call.participants.has(toUserId)) {
      throw new CallRegistryError("The signal recipient is not in this call.", "INVALID_RECIPIENT");
    }
    return this.snapshot(call);
  }

  removeDisconnectedUser(userId: string): Array<{
    call: CallSnapshot;
    kind: "participant-left" | "cancelled" | "expired";
    ended: boolean;
    notifyUserIds: string[];
  }> {
    const callId = this.callByUser.get(userId);
    if (!callId) return [];
    const call = this.calls.get(callId);
    if (!call) {
      this.callByUser.delete(userId);
      return [];
    }
    const notifyUserIds = [
      ...call.participants.keys(),
      ...call.pendingUsers.keys(),
    ];

    if (call.pendingUsers.has(userId)) {
      this.removePending(call, userId);
      const ended = call.pendingUsers.size === 0 && call.participants.size === 1;
      if (ended) {
        this.removeCall(call);
        return [{
          call: this.snapshot(call),
          kind: "expired",
          ended: true,
          notifyUserIds,
        }];
      }
      return [{
        call: this.snapshot(call),
        kind: "participant-left",
        ended: false,
        notifyUserIds,
      }];
    }

    if (!call.participants.has(userId)) return [];
    if (call.caller.id === userId && call.participants.size === 1) {
      this.removeCall(call);
      return [{
        call: this.snapshot(call),
        kind: "cancelled",
        ended: true,
        notifyUserIds,
      }];
    }
    call.participants.delete(userId);
    this.callByUser.delete(userId);
    const ended =
      call.participants.size === 0 ||
      (call.participants.size === 1 && call.pendingUsers.size === 0);
    if (ended) this.removeCall(call);
    return [{
      call: this.snapshot(call),
      kind: "participant-left",
      ended,
      notifyUserIds,
    }];
  }

  expire(now = Date.now()): CallSnapshot[] {
    const expired: CallSnapshot[] = [];
    for (const call of this.calls.values()) {
      if (call.expiresAt > now || call.participants.size !== 1) continue;
      expired.push(this.snapshot(call));
      this.removeCall(call);
    }
    return expired;
  }

  private requireCall(callId: string) {
    const call = this.calls.get(callId);
    if (!call) throw new CallRegistryError("Call not found.", "CALL_NOT_FOUND");
    return call;
  }

  private removePending(call: CallRecord, userId: string) {
    call.pendingUsers.delete(userId);
    this.callByUser.delete(userId);
  }

  private removeCall(call: CallRecord) {
    for (const userId of call.participants.keys()) this.callByUser.delete(userId);
    for (const userId of call.pendingUsers.keys()) this.callByUser.delete(userId);
    this.calls.delete(call.id);
  }

  private snapshot(call: CallRecord): CallSnapshot {
    return {
      id: call.id,
      conversationId: call.conversationId,
      conversationName: call.conversationName,
      callType: call.callType,
      mode: call.mode,
      status: call.status,
      caller: call.caller,
      participants: [...call.participants.values()],
      pendingUserIds: [...call.pendingUsers.keys()],
      startedAt: call.startedAt,
    };
  }
}
