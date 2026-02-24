export interface SharedSabChannel<TBuffers, TViews> {
  id: number;
  buffers: TBuffers;
  views: TViews;
  inFlightRequestId: number | null;
}

interface SharedSabChannelPoolOptions<TBuffers, TViews> {
  initialChannelCount: number;
  maxChannelCount: number;
  createBuffers: () => TBuffers;
  createViews: (buffers: TBuffers) => TViews;
  onChannelInitialized: (channelId: number, buffers: TBuffers) => void;
}

function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

export class SharedSabChannelPool<TBuffers, TViews> {
  private readonly initialChannelCount: number;
  private readonly maxChannelCount: number;
  private readonly createBuffers: () => TBuffers;
  private readonly createViews: (buffers: TBuffers) => TViews;
  private readonly onChannelInitialized: (channelId: number, buffers: TBuffers) => void;
  private readonly channels: Array<SharedSabChannel<TBuffers, TViews>> = [];

  constructor(options: SharedSabChannelPoolOptions<TBuffers, TViews>) {
    this.initialChannelCount = clampPositiveInteger(options.initialChannelCount, 1);
    this.maxChannelCount = Math.max(
      this.initialChannelCount,
      clampPositiveInteger(options.maxChannelCount, this.initialChannelCount)
    );
    this.createBuffers = options.createBuffers;
    this.createViews = options.createViews;
    this.onChannelInitialized = options.onChannelInitialized;
  }

  initializeChannels(): void {
    while (this.channels.length < this.initialChannelCount) {
      this.createChannel();
    }
  }

  getChannels(): readonly SharedSabChannel<TBuffers, TViews>[] {
    return this.channels;
  }

  canCreateChannel(): boolean {
    return this.channels.length < this.maxChannelCount;
  }

  claimChannelForRequest(requestId: number): SharedSabChannel<TBuffers, TViews> | null {
    for (const channel of this.channels) {
      if (channel.inFlightRequestId !== null) continue;
      channel.inFlightRequestId = requestId;
      return channel;
    }

    if (this.channels.length >= this.maxChannelCount) {
      return null;
    }

    const channel = this.createChannel();
    channel.inFlightRequestId = requestId;
    return channel;
  }

  claimSpecificChannelForRequest(
    requestId: number,
    channelId: number
  ): SharedSabChannel<TBuffers, TViews> | null {
    const channel = this.getChannel(channelId);
    if (!channel || channel.inFlightRequestId !== null) {
      return null;
    }
    channel.inFlightRequestId = requestId;
    return channel;
  }

  createChannelForRequest(requestId: number): SharedSabChannel<TBuffers, TViews> | null {
    if (!this.canCreateChannel()) {
      return null;
    }
    const channel = this.createChannel();
    channel.inFlightRequestId = requestId;
    return channel;
  }

  releaseChannelForRequest(requestId: number): void {
    for (const channel of this.channels) {
      if (channel.inFlightRequestId !== requestId) continue;
      channel.inFlightRequestId = null;
      return;
    }
  }

  getChannel(channelId: number): SharedSabChannel<TBuffers, TViews> | null {
    if (!Number.isInteger(channelId) || channelId < 0 || channelId >= this.channels.length) {
      return null;
    }
    return this.channels[channelId] ?? null;
  }

  replaceChannelBuffers(
    channelId: number,
    buffers: TBuffers,
    views: TViews
  ): SharedSabChannel<TBuffers, TViews> | null {
    const previous = this.getChannel(channelId);
    if (!previous) return null;
    const next: SharedSabChannel<TBuffers, TViews> = {
      id: channelId,
      buffers,
      views,
      inFlightRequestId: previous.inFlightRequestId
    };
    this.channels[channelId] = next;
    return next;
  }

  clearInFlightRequests(): void {
    for (const channel of this.channels) {
      channel.inFlightRequestId = null;
    }
  }

  private createChannel(): SharedSabChannel<TBuffers, TViews> {
    const id = this.channels.length;
    const buffers = this.createBuffers();
    const views = this.createViews(buffers);
    const channel: SharedSabChannel<TBuffers, TViews> = {
      id,
      buffers,
      views,
      inFlightRequestId: null
    };
    this.channels.push(channel);
    this.onChannelInitialized(id, buffers);
    return channel;
  }
}

interface ClaimBestFitSabChannelOptions<TBuffers, TViews, TCapacity, TRequiredCapacity> {
  pool: SharedSabChannelPool<TBuffers, TViews>;
  requestId: number;
  requiredCapacity: TRequiredCapacity | null;
  getChannelCapacity: (channel: SharedSabChannel<TBuffers, TViews>) => TCapacity;
  canChannelFitCapacity: (
    channelCapacity: TCapacity,
    requiredCapacity: TRequiredCapacity
  ) => boolean;
  compareCapacitiesAscending: (left: TCapacity, right: TCapacity) => number;
  ensureChannelCapacity: (
    channel: SharedSabChannel<TBuffers, TViews>,
    requiredCapacity: TRequiredCapacity
  ) => boolean;
}

export function claimBestFitSabChannelForRequest<TBuffers, TViews, TCapacity, TRequiredCapacity>(
  options: ClaimBestFitSabChannelOptions<TBuffers, TViews, TCapacity, TRequiredCapacity>
): SharedSabChannel<TBuffers, TViews> | null {
  const {
    pool,
    requestId,
    requiredCapacity,
    getChannelCapacity,
    canChannelFitCapacity,
    compareCapacitiesAscending,
    ensureChannelCapacity
  } = options;
  if (requiredCapacity === null) {
    return pool.claimChannelForRequest(requestId);
  }

  const availableChannels = pool
    .getChannels()
    .filter((channel) => channel.inFlightRequestId === null);
  let bestFitChannel: SharedSabChannel<TBuffers, TViews> | null = null;
  let bestFitCapacity: TCapacity | null = null;

  for (const channel of availableChannels) {
    const channelCapacity = getChannelCapacity(channel);
    if (!canChannelFitCapacity(channelCapacity, requiredCapacity)) continue;
    if (!bestFitCapacity || compareCapacitiesAscending(channelCapacity, bestFitCapacity) < 0) {
      bestFitChannel = channel;
      bestFitCapacity = channelCapacity;
    }
  }

  if (bestFitChannel) {
    return pool.claimSpecificChannelForRequest(requestId, bestFitChannel.id);
  }

  let growthTargetChannel: SharedSabChannel<TBuffers, TViews> | null = null;
  let growthTargetCapacity: TCapacity | null = null;
  for (const channel of availableChannels) {
    const channelCapacity = getChannelCapacity(channel);
    if (
      !growthTargetCapacity ||
      compareCapacitiesAscending(channelCapacity, growthTargetCapacity) > 0
    ) {
      growthTargetChannel = channel;
      growthTargetCapacity = channelCapacity;
    }
  }

  if (growthTargetChannel) {
    const claimed = pool.claimSpecificChannelForRequest(requestId, growthTargetChannel.id);
    if (claimed && ensureChannelCapacity(claimed, requiredCapacity)) {
      return claimed;
    }
    if (claimed) {
      pool.releaseChannelForRequest(requestId);
    }
  }

  const created = pool.createChannelForRequest(requestId);
  if (created && ensureChannelCapacity(created, requiredCapacity)) {
    return created;
  }
  if (created) {
    pool.releaseChannelForRequest(requestId);
  }

  const fallback = pool.claimChannelForRequest(requestId);
  if (fallback && ensureChannelCapacity(fallback, requiredCapacity)) {
    return fallback;
  }
  if (fallback) {
    pool.releaseChannelForRequest(requestId);
  }
  return null;
}
