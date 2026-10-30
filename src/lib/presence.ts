export type PresenceDisconnect = {
  found: boolean;
  lastSocket: boolean;
};

export class UserSocketRegistry {
  private readonly socketsByUserId = new Map<string, Set<string>>();

  connect(userId: string, socketId: string) {
    let sockets = this.socketsByUserId.get(userId);
    const becameOnline = !sockets;
    if (!sockets) {
      sockets = new Set<string>();
      this.socketsByUserId.set(userId, sockets);
    }
    sockets.add(socketId);
    return becameOnline;
  }

  disconnect(userId: string, socketId: string): PresenceDisconnect {
    const sockets = this.socketsByUserId.get(userId);
    if (!sockets || !sockets.delete(socketId)) {
      return { found: false, lastSocket: false };
    }
    if (sockets.size > 0) return { found: true, lastSocket: false };
    this.socketsByUserId.delete(userId);
    return { found: true, lastSocket: true };
  }

  isOnline(userId: string) {
    return this.socketsByUserId.has(userId);
  }

  onlineUserIds(userIds: Iterable<string>) {
    return new Set([...userIds].filter((userId) => this.isOnline(userId)));
  }

  activeUserIds() {
    return [...this.socketsByUserId.keys()];
  }
}
