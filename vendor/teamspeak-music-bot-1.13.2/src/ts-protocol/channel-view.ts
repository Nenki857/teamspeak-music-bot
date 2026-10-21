import { parseCommand } from "@honeybbq/teamspeak-client/command";
import type { Packet } from "@honeybbq/teamspeak-client/transport";

export interface VisibleChannel { id: string; name: string; parentId: string }

/** Read the channel view the server sends to an ordinary voice client on login.
 * This does not require the ServerQuery `channellist` permission. */
export class ChannelView {
  private channels = new Map<string, VisibleChannel>();
  private clientChannels = new Map<string, string>();
  clear(): void { this.channels.clear(); this.clientChannels.clear(); }
  clientChannel(id: number): string | undefined { return this.clientChannels.get(String(id)); }
  confirmClientChannel(id: number, channelId: string): void { this.clientChannels.set(String(id), channelId); }
  list(): VisibleChannel[] { return [...this.channels.values()]; }
  observePacket(packet: Packet): void {
    if (![2, 3].includes(packet.typeFlagged & 15)) return;
    this.observeText(Buffer.from(packet.data).toString("utf8"));
  }
  observeText(text: string): void {
    for (const raw of text.split(/[\n\0]/)) {
      const line = raw.replace(/\r$/, ""); const split = line.indexOf(" ");
      const commandName = split < 0 ? line : line.slice(0, split);
      const records = split < 0 ? [line] : line.slice(split + 1).split("|").map(body => `${commandName} ${body}`);
      for (const record of records) {
        const parsed = parseCommand(record); if (!parsed) continue;
        const params = { ...parsed.params };
        if (parsed.name.startsWith("cid=")) params.cid = parsed.name.slice(4);
        if (parsed.name.startsWith("clid=")) params.clid = parsed.name.slice(5);
        if (params.clid && /^\d+$/.test(params.clid)) {
          if (parsed.name === "notifyclientleftview") this.clientChannels.delete(params.clid);
          else {
            const channelId = params.ctid ?? params.cid;
            if (channelId && /^\d+$/.test(channelId)) this.clientChannels.set(params.clid, channelId);
          }
        }
        const id = params.cid; if (!id || !/^\d+$/.test(id)) continue;
        if (parsed.name === "notifychanneldeleted") { this.channels.delete(id); continue; }
        const old = this.channels.get(id);
        if (params.channel_name !== undefined) this.channels.set(id, { id, name: params.channel_name, parentId: params.cpid ?? params.pid ?? old?.parentId ?? "0" });
        else if (parsed.name === "notifychannelmoved" && old) this.channels.set(id, { ...old, parentId: params.cpid ?? params.pid ?? old.parentId });
      }
    }
  }
  resolve(name: string): VisibleChannel | undefined {
    const exact = this.list().filter(channel => channel.name === name);
    if (exact.length > 1) throw new Error("频道重名，请填写频道 ID");
    if (exact.length === 1) return exact[0];
    const paths = this.list().filter(channel => {
      const parts = [channel.name]; const seen = new Set([channel.id]); let parent = this.channels.get(channel.parentId);
      while (parent && !seen.has(parent.id)) { seen.add(parent.id); parts.unshift(parent.name); parent = this.channels.get(parent.parentId); }
      return parts.join("/") === name.replace(/^\//, "");
    });
    if (paths.length > 1) throw new Error("频道路径重名，请填写频道 ID");
    return paths[0];
  }
}
