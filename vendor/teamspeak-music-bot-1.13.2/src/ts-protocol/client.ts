import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  Client as TS3FullClient,
  generateIdentity as genTS3Identity,
  getUidFromPublicKey,
  identityFromString,
  sendTextMessage,
  listClients,
  clientMove,
  getClientInfo,
  fileTransferDeleteFile,
  type Identity,
  type TextMessage,
  type ClientInfo,
  type ClientLeftViewEvent,
  type ClientMovedEvent,
  type VoiceData,
  type FileUploadInfo,
} from "@honeybbq/teamspeak-client";
import type { Logger } from "../logger.js";
import {
  detectServerProtocol,
  type ServerProtocol,
} from "./protocol-detect.js";
import { TS6HttpQuery } from "./http-query.js";
import {
  TrackingVoiceEndpointResolver,
  DirectVoiceEndpointResolver,
  type ResolvedVoiceEndpoint,
} from "./voice-endpoint.js";
import { ChannelView } from "./channel-view.js";
import { VoiceTransportMonitor } from "./voice-transport-monitor.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";
export type { ServerProtocol } from "./protocol-detect.js";
export type { FileUploadInfo } from "@honeybbq/teamspeak-client";

/** Escape a string for use in TS3 ServerQuery-style commands. */
export function escapeTS3(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelId?: string; // Numeric channel ID (takes precedence over defaultChannel)
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
  directVoiceConnection?: boolean;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
  invokerGroups: string[]; // sender's TS server-group ids; [] when not in view cache
}

/** Lightweight voice-packet signal used for activity detection. The encoded
 * payload is intentionally not forwarded beyond this protocol wrapper. */
export interface TS3VoiceActivity {
  clientId: number;
  codec: number;
  /** Stable TeamSpeak identity when the sender is present in the client view. */
  clientUid?: string;
}

// Command notifications and UDP voice packets can be reordered in flight.
// Retain a leaving client's UID briefly so its final packet is still
// attributable; a new clientEnter for the same id cancels and overwrites it.
const VISIBLE_CLIENT_UID_RELEASE_GRACE_MS = 1_000;

/**
 * Map the library's TextMessage to our wrapper. Preserves invokerGroups (the
 * sender's TS server groups), which the library populates only when the sender
 * is in the bot's client-view cache; otherwise it is []. Used by the chat
 * command permission gate.
 */
export function toTS3TextMessage(msg: TextMessage): TS3TextMessage {
  return {
    invokerName: msg.invokerName,
    invokerId: String(msg.invokerID),
    invokerUid: msg.invokerUID,
    message: msg.message,
    targetMode: msg.targetMode,
    invokerGroups: msg.invokerGroups ?? [],
  };
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private readonly clientUid: string;
  private clientId = 0;
  private readonly visibleClientUids = new Map<number, string>();
  private readonly visibleClientUidReleaseTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly voiceEndpointResolver: TrackingVoiceEndpointResolver;
  private readonly channelView = new ChannelView();
  private readonly voiceTransport = new VoiceTransportMonitor();

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;
    this.voiceEndpointResolver = new TrackingVoiceEndpointResolver(options.directVoiceConnection ? new DirectVoiceEndpointResolver() : undefined);

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
    this.clientUid = getUidFromPublicKey(this.identity.publicKeyBase64());
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  async connect(): Promise<void> {
    this.voiceStreamActive = false;
    this.voiceTransport.detach();
    this.voiceEndpointResolver.reset();
    this.channelView.clear();
    this.disconnecting = false;
    this.clearVisibleClientUids();
    // Clean up any existing connection before creating a new one
    if (this.client) {
      this.logger.info("Cleaning up previous connection before reconnecting");
      try {
        await this.client.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      this.client = null;
      this.clientId = 0;
    }

    const addr = `${this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host}:${this.options.port}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info(
        { addr, protocol: this.detectedProtocol },
        "Using forced server protocol",
      );
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      const detection = await detectServerProtocol(
        this.options.host,
        this.options.port,
        3000,
        { ts3QueryPort: 10011, ts6HttpPort: 10080 },
      );
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: this.options.host,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    // Guard against calling connect() while already connected.
    // Save detectedProtocol first because disconnect() resets it.
    if (this.client) {
      this.logger.warn("connect() called while already connected, disconnecting first");
      const savedProtocol = this.detectedProtocol;
      const savedHttpQuery = this.httpQuery;
      this.disconnect();
      this.detectedProtocol = savedProtocol;
      this.httpQuery = savedHttpQuery;
      // Give the old client a moment to tear down
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let udpErrorCount = 0;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        if (udpErrorCount === 1) {
          this.logger.warn(msg);
          // After 2 seconds, log a summary and reset.
          // Clear any previous timer to avoid leaking it.
          if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
          this.udpErrorTimer = setTimeout(() => {
            if (udpErrorCount > 1) {
              this.logger.warn(`udp send error (repeated ${udpErrorCount} times, connection may be lost)`);
            }
            udpErrorCount = 0;
            this.udpErrorTimer = null;
          }, 2000);
        }
        return;
      }
      this.logger.warn(msg);
    };

    this.client = new TS3FullClient(this.identity, addr, this.options.nickname, {
      // Forward server password to the protocol library so it can be
      // included in clientinit for password-protected servers
      serverPassword: this.options.serverPassword,
      defaultChannel: this.options.channelId ? "" : this.options.defaultChannel,
      defaultChannelPassword: this.options.channelPassword,
      resolver: this.voiceEndpointResolver,
      logger: {
        debug: (msg) => this.logger.debug(msg),
        info: (msg) => this.logger.info(msg),
        warn: throttledWarn,
        error: (msg) => this.logger.error(msg),
      },
    });

    this.client.on("textMessage", (msg: TextMessage) => {
      if (msg.invokerID === this.clientId) return;
      this.emit("textMessage", toTS3TextMessage(msg));
    });

    this.client.on("voiceData", (voice: VoiceData) => {
      // The library normally suppresses our own packets; retain the explicit
      // guard so a future protocol change cannot make a bot duck itself.
      if (voice.clientId === this.clientId) return;
      const clientUid = this.visibleClientUids.get(voice.clientId);
      const activity: TS3VoiceActivity = {
        clientId: voice.clientId,
        codec: voice.codec,
        ...(clientUid ? { clientUid } : {}),
      };
      this.emit("voiceActivity", activity);
    });

    this.client.on("disconnected", (err) => {
      if (this.client === connection) { this.voiceTransport.detach(); this.voiceStreamActive = false; }
      this.logger.warn({ err: err?.message }, "Connection closed");
      this.clientId = 0;
      this.clearVisibleClientUids();
      this.emit("disconnected");
    });

    this.client.on("clientEnter", (info: ClientInfo) => {
      this.rememberVisibleClientUid(info.id, info.uid);
      this.logger.debug(
        { nickname: info.nickname, id: info.id },
        "Client entered"
      );
      // The pinned SDK reads only `cid` for enter-view notifications, while
      // TS3 also sends the destination as `ctid`. Our packet view observes
      // that field before SDK callbacks run, so restore it without a query.
      const observedChannel = this.channelView.clientChannel(info.id);
      this.emit("clientEnter", observedChannel ? { ...info, channelID: BigInt(observedChannel) } : info);
    });

    this.client.on("clientLeave", (ev: ClientLeftViewEvent) => {
      this.releaseVisibleClientUid(ev.id);
      this.logger.debug({ id: ev.id }, "Client left");
      this.emit("clientLeave", ev);
    });

    this.client.on("clientMoved", (ev: ClientMovedEvent) => {
      this.logger.debug(
        { id: ev.id, targetChannelID: ev.targetChannelID.toString() },
        "Client moved"
      );
      this.emit("clientMoved", ev);
    });

    const connection = this.client;
    // connect() synchronously recreates the SDK transport before DNS awaits.
    const dialing = connection.connect();
    const start = connection.handler.start.bind(connection.handler);
    connection.handler.start = socket => {
      if (this.client === connection && !this.disconnecting) this.voiceTransport.attach(socket);
      return start(socket);
    };
    const receive = connection.handler.onPacket;
    connection.handler.onPacket = packet => {
      if (this.client === connection) { this.voiceTransport.observePacket(packet); this.channelView.observePacket(packet); }
      receive?.(packet);
    };
    await dialing;
    if (this.client !== connection || this.disconnecting) {
      connection.handler.close();
      throw new Error("连接已取消");
    }
    // Note: @honeybbq/teamspeak-client 0.2.x ships a universal clientinit
    // (client_version "3.?.? [Build: 5680278000]" + matching signature)
    // that works against both TS3 and TS6 servers. The old 3.6.2 monkey-
    // patch on handler.sendPacket was removed when we bumped to 0.2.1 — it
    // would have replaced the library's new correct version with a stale
    // signature and made TS6 handshakes fail.
    await connection.waitConnected();
    if (this.client !== connection || this.disconnecting) {
      connection.handler.close();
      throw new Error("连接已取消");
    }
    this.clientId = this.client.clientID();
    this.voiceFramesSent = 0;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    // Wait for the welcome view containing our actual channel, not a Query call.
    for (let i = 0; i < 20 && this.getChannelId() === 0n; i++) {
      if (this.client !== connection || this.disconnecting) throw new Error("连接已取消");
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Join channel by numeric ID (takes precedence) or by name
    if (this.options.channelId) {
      await this.joinChannel(this.options.channelId, this.options.channelPassword);
    } else if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    this.emit("connected");
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    if (!this.client) throw new Error("TeamSpeak 尚未连接");
    let target: bigint;
    if (/^\d+$/.test(channelName)) target = BigInt(channelName);
    else {
      let channel = this.channelView.resolve(channelName);
      for (let i = 0; i < 20 && !channel; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        channel = this.channelView.resolve(channelName);
      }
      if (!channel) throw new Error("可见频道中找不到目标频道，请核对名称或填写频道 ID");
      target = BigInt(channel.id);
    }
    if (this.getChannelId() === target) return;
    try { await clientMove(this.client, this.clientId, target, password); }
    catch (error) {
      // This server response confirms our own client is already in that target.
      if (Number((error as { id?: string | number }).id) !== 770) throw error;
    }
    // A successful move acknowledgement is authoritative even when the SDK
    // omitted our initial clientlist entry from its private view cache.
    this.channelView.confirmClientChannel(this.clientId, target.toString());
    this.logger.info({ cid: target.toString() }, "Joined channel");
  }

  async listVisibleChannels(): Promise<{ id: string; name: string }[]> {
    if (!this.client) throw new Error("TeamSpeak 尚未连接");
    return this.channelView.list().map(ch => ({ id: ch.id, name: ch.name }));
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2,
    waitForReply: boolean = false
  ): Promise<void> {
    if (!this.client) { if (waitForReply) throw new Error("TeamSpeak 尚未连接"); return; }
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    if (waitForReply) {
      // Sharing status must reflect the server's command reply, including
      // permission errors, rather than only local transport submission.
      await this.client.execCommand(`sendtextmessage targetmode=${targetMode} target=${target} msg=${escapeTS3(message)}`, 5000);
    } else await sendTextMessage(this.client, targetMode, target, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = this.getChannelId();
      return allClients.filter((c) => c.channelID === myChannelId);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a client's CURRENT server groups by client id, server-wide (works
   * regardless of channel/view) via a targeted `clientinfo` query. The raw
   * `client_servergroups` field is a comma-separated list (same field
   * `listClients` parses). Returns [] if the client can't be resolved or the
   * query fails, so callers fail closed.
   */
  async getClientServerGroups(clid: number): Promise<string[]> {
    if (!this.client) return [];
    try {
      const info = await getClientInfo(this.client, clid);
      // `client_servergroups`: comma-separated server-group ids (verified in
      // @honeybbq/teamspeak-client dist/index.mjs; listClients parses the same).
      const raw = info.client_servergroups ?? "";
      return raw ? raw.split(",") : [];
    } catch {
      return [];
    }
  }

  // --- Raw command & file transfer pass-through ---

  async execCommand(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.execCommand(cmd);
  }

  /** Fire a command without waiting for the server's response. */
  async sendCommandNoWait(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.sendCommandNoWait(cmd);
  }

  async execCommandWithResponse(cmd: string): Promise<Record<string, string>[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.execCommandWithResponse(cmd);
  }

  async fileTransferInitUpload(
    channelID: bigint,
    path: string,
    password: string,
    size: bigint,
    overwrite = true,
  ): Promise<FileUploadInfo> {
    if (!this.client) throw new Error("Not connected");
    return this.client.fileTransferInitUpload(channelID, path, password, size, overwrite);
  }

  async uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.uploadFileData(host, info, data);
  }

  async fileTransferDeleteFile(channelID: bigint, paths: string[]): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await fileTransferDeleteFile(this.client, channelID, paths);
  }

  /** The server host (needed for file transfer TCP connections). */
  getHost(): string {
    return this.options.host;
  }

  /** The current channel ID of this client. */
  getChannelId(): bigint {
    if (!this.client) return 0n;
    const observed = this.channelView.clientChannel(this.clientId || this.client.clientID());
    return observed ? BigInt(observed) : this.client.channelID();
  }

  private voiceFramesSent = 0;
  private voiceStreamActive = false;

  getVoiceTransportStatistics() { return this.voiceTransport.snapshot(); }

  sendVoiceData(opusFrame: Buffer): void {
    if (!this.client || this.disconnecting) return;
    if (!opusFrame.length) { this.endVoiceStream(); return; }
    try {
      this.client.sendVoice(opusFrame, 5);
      this.voiceStreamActive = true;
      this.voiceFramesSent++;
      if (this.voiceFramesSent === 1) {
        this.logger.info({ opusBytes: opusFrame.length, clientId: this.clientId }, "First voice packet sent to TeamSpeak");
      }
    } catch (err) {
      if (this.voiceFramesSent === 0) {
        this.logger.error({ err }, "Failed to send first voice packet");
      }
    }
  }

  endVoiceStream(): void {
    if (!this.voiceStreamActive) return;
    this.voiceStreamActive = false;
    if (!this.client || this.disconnecting) return;
    // TS signals end-of-stream with an empty voice payload, not a dropped
    // UDP packet. Let the SDK maintain the regular voice packet sequence.
    try { this.client.sendVoice(Buffer.alloc(0), 5); }
    catch { this.logger.warn("Failed to submit voice end marker"); }
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  /** Actual endpoint selected by the SDK's SRV/TSDNS discovery and DNS lookup. */
  getResolvedVoiceEndpoint(): ResolvedVoiceEndpoint | null {
    return this.voiceEndpointResolver.getEndpoint();
  }

  /** Stable identity of this managed TeamSpeak client. */
  getClientUid(): string {
    return this.clientUid;
  }

  private rememberVisibleClientUid(clientId: number, clientUid: string): void {
    const pendingRelease = this.visibleClientUidReleaseTimers.get(clientId);
    if (pendingRelease) clearTimeout(pendingRelease);
    this.visibleClientUidReleaseTimers.delete(clientId);

    if (clientId > 0 && clientUid) {
      this.visibleClientUids.set(clientId, clientUid);
    } else {
      this.visibleClientUids.delete(clientId);
    }
  }

  private releaseVisibleClientUid(clientId: number): void {
    const clientUid = this.visibleClientUids.get(clientId);
    if (!clientUid) return;

    const previous = this.visibleClientUidReleaseTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.visibleClientUids.get(clientId) === clientUid) {
        this.visibleClientUids.delete(clientId);
      }
      this.visibleClientUidReleaseTimers.delete(clientId);
    }, VISIBLE_CLIENT_UID_RELEASE_GRACE_MS);
    timer.unref?.();
    this.visibleClientUidReleaseTimers.set(clientId, timer);
  }

  private clearVisibleClientUids(): void {
    for (const timer of this.visibleClientUidReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this.visibleClientUidReleaseTimers.clear();
    this.visibleClientUids.clear();
  }

  disconnect(): void {
    this.endVoiceStream();
    this.voiceTransport.detach();
    if (this.client && !this.disconnecting) {
      this.disconnecting = true;
      const client = this.client;
      client.disconnect().catch(() => {}).finally(() => {
        if (this.client === client) {
          this.client = null;
        }
        this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.clearVisibleClientUids();
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    if (this.udpErrorTimer) {
      clearTimeout(this.udpErrorTimer);
      this.udpErrorTimer = null;
    }
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
