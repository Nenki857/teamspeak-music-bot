// Observe TS push events only. No client-list queries, names or identities cross threads.
export function observeChannelJoins(client, onJoin) {
  let channel = String(client.getChannelId()); const present = new Set();
  const entered = (event, target) => {
    const current = String(client.getChannelId());
    if (current !== channel) { channel = current; present.clear(); }
    const id = Number(event.id);
    if (!Number.isInteger(id) || id <= 0 || id === client.getClientId()) return;
    const destination = String(target ?? '');
    if (channel === '0' || destination !== channel) { present.delete(id); return; }
    if (present.has(id)) return;
    present.add(id); onJoin({ channelId: channel });
  };
  const enter = event => { if (event.type === 1) return; entered(event, event.channelID); };
  const move = event => entered(event, event.targetChannelID);
  const leave = event => present.delete(Number(event.id));
  client.on('clientEnter', enter); client.on('clientMoved', move); client.on('clientLeave', leave);
  return () => { client.off('clientEnter', enter); client.off('clientMoved', move); client.off('clientLeave', leave); present.clear(); };
}
