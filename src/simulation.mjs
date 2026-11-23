// A local economic game. Participants and results are deterministic synthetic data.
const PROFILE = [
  ['Budget', 6, 190, 90, 100],
  ['Balanced', 10, 135, 96, 80],
  ['Fast', 15, 95, 96, 60],
  ['Reliable', 17, 140, 99, 70],
];
const INITIAL = 1200;
const TOTAL_ROUNDS = 6;
const SCALE = 10;
const PER_CUSTOMER_COST = 6;
const OFFER = {
  price: { type: 'integer', minimum: 3, maximum: 20 },
  latency: { type: 'integer', minimum: 60, maximum: 220 },
  availability: { type: 'integer', minimum: 90, maximum: 100 },
};
const operation = (action, args = {}) => ({
  type: 'object', properties: { action: { const: action, type: 'string' }, ...args },
  required: ['action', ...Object.keys(args)], additionalProperties: false,
});
export const marketToolSchema = {
  type: 'object',
  properties: { request: { anyOf: [operation('observe'), operation('publish_offer', OFFER), operation('advance')] } },
  required: ['request'], additionalProperties: false,
};
export function createSimulation() {
  let round = 0, cash = INITIAL, total = 0, offer = null, last = null, previous = null;
  const observe = () => ({
    round, periods: TOTAL_ROUNDS, cash, totalAdoptions: total, offer: offer && { ...offer },
    last: last && { ...last }, previous: previous && { ...previous },
    costs: { base: 30, perAdoption: PER_CUSTOMER_COST, latency: '2 * (220 - ms)', availability: '5 * (percent - 90)^2' },
    segments: PROFILE.map(([name, maxPrice, maxLatency, minAvailability, demand]) =>
      ({ name, maxPrice, maxLatency, minAvailability, nextDemand: demand + SCALE * (((round + demand) % 3) - 1) })),
  });
  const execute = request => {
    const { action } = request ?? {};
    if (action === 'observe' && Object.keys(request).length === 1)
      return { summary: 'Inspected the fictional market.', data: observe() };
    if (round === TOTAL_ROUNDS) throw new Error('The market is closed');
    if (action === 'publish_offer') {
      if (Object.keys(request).length !== 4) throw new Error('Expected price, latency, and availability');
      for (const [key, { minimum, maximum }] of Object.entries(OFFER))
        if (!Number.isInteger(request[key]) || request[key] < minimum || request[key] > maximum)
          throw new Error('Published offer parameter outside allowed bounds');
      const { price, latency, availability } = request;
      offer = { price, latency, availability };
      return { summary: 'Published an offer: ' + price + ' credits, ' + latency + ' ms, ' + availability + '% availability.', data: observe() };
    }
    if (action !== 'advance' || Object.keys(request).length !== 1) throw new Error('Invalid market action');
    if (!offer) throw new Error('Publish an offer before advancing');
    const { price, latency, availability } = offer;
    const fixedCost = 30 + 2 * (220 - latency) + 5 * (availability - 90) ** 2;
    if (cash < fixedCost) throw new Error('Reserve cannot fund this offer; publish a cheaper service');
    const segments = observe().segments;
    const demand = segments.reduce((sum, s) => sum + s.nextDemand, 0);
    const chosen = segments.filter(p => price <= p.maxPrice &&
      latency <= p.maxLatency && availability >= p.minAvailability);
    const adopted = chosen.reduce((sum, s) => sum + s.nextDemand, 0);
    const cost = fixedCost + adopted * PER_CUSTOMER_COST;
    const net = adopted * price - cost;
    if (cash + net < 0) throw new Error('Offer would exhaust reserves; publish a sustainable offer');
    round++;
    cash += net;
    total += adopted;
    previous = last;
    const share = Math.round(1000 * adopted / demand) / 10;
    last = { adopted, demand, share, net, cost, segments: chosen.map(s => s.name).join(', ') };
    const trend = previous ? ' (was ' + previous.share + '%)' : '';
    return { summary: 'Period ' + round + ': ' + adopted + '/' + demand + ' traffic units, ' +
      share + '%' + trend + '; net ' + net + ' credits; reserve ' + cash + '.', data: observe() };
  };
  return { execute, observe };
}
