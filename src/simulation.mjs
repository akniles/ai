// These commands change an in-memory fictional network. No process or socket is reachable.
export function createSimulation() {
  const nodes = new Map([['relay', false], ['archive', false], ['gateway', false]]);
  const commands = Object.freeze(['status', 'claim relay', 'claim archive', 'claim gateway']);
  const status = () => [...nodes].map(([name, claimed]) =>
    name + ': ' + (claimed ? 'claimed' : 'unclaimed')).join(', ');
  return {
    commands, status,
    execute(command) {
      if (command === 'status') return status();
      const node = command.startsWith('claim ') ? command.slice(6) : '';
      if (!nodes.has(node)) throw new Error('Unknown simulation command');
      if (nodes.get(node)) return node + ' was already claimed';
      nodes.set(node, true);
      return 'Claimed ' + node;
    },
  };
}
