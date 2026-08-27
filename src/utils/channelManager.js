import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getDataDir } from './paths.js';
import logger from './logger.js';

const CHANNELS_FILE = 'channels.json';

class ChannelManager {
  constructor() {
    this.filePath = null;
    this.channels = [];
    this.initialized = false;
    this.savePromise = Promise.resolve();
    this.channelUsageIndices = new Map(); // 用于 round_robin 索引记录
  }

  async init() {
    if (this.initialized) return;
    const dataDir = getDataDir();
    this.filePath = path.join(dataDir, CHANNELS_FILE);
    await this.load();
    this.initialized = true;
  }

  async load() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const content = await fs.readFile(this.filePath, 'utf8');
        const data = JSON.parse(content);
        this.channels = Array.isArray(data) ? data : (data.channels || []);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          logger.error('加载外部渠道配置失败:', e.message);
        }
        this.channels = [];
      }
    } catch (e) {
      logger.error('初始化外部渠道管理器失败:', e.message);
      this.channels = [];
    }
  }

  async save() {
    this.savePromise = this.savePromise.then(async () => {
      try {
        await fs.writeFile(this.filePath, JSON.stringify(this.channels, null, 2), 'utf8');
      } catch (e) {
        logger.error('保存外部渠道配置失败:', e.message);
      }
    });
    return this.savePromise;
  }

  /**
   * 获取所有渠道列表（对 API Key 进行脱敏展示）
   */
  async getChannels() {
    if (!this.initialized) await this.init();
    return this.channels.map(c => {
      let maskedKey = '';
      if (c.apiKey && typeof c.apiKey === 'string') {
        maskedKey = c.apiKey.length > 8 
          ? `${c.apiKey.substring(0, 4)}...${c.apiKey.substring(c.apiKey.length - 4)}` 
          : '******';
      }
      return {
        ...c,
        apiKeyMasked: maskedKey,
        hasKey: !!c.apiKey
      };
    });
  }

  /**
   * 根据 ID 获取单个渠道完整信息
   */
  async getChannelById(id) {
    if (!this.initialized) await this.init();
    return this.channels.find(c => c.id === id);
  }

  /**
   * 添加新渠道
   */
  async addChannel(channelData) {
    if (!this.initialized) await this.init();

    const newChannel = {
      id: 'chan_' + crypto.randomBytes(6).toString('hex'),
      name: channelData.name || '外部渠道',
      type: channelData.type || 'openai', // 'openai' | 'gemini' | 'claude'
      baseUrl: (channelData.baseUrl || '').replace(/\/+$/, ''), // 去除末尾斜杠
      apiKey: channelData.apiKey || '',
      models: Array.isArray(channelData.models) ? channelData.models : (channelData.models ? channelData.models.split(',').map(m => m.trim()) : []),
      enable: channelData.enable ?? true,
      priority: Number(channelData.priority) || 10, // 默认优先级 10 (数值越小优先级越高)
      weight: Number(channelData.weight) || 1,
      totalRequests: 0,
      totalTokens: 0,
      createdAt: Date.now()
    };

    this.channels.push(newChannel);
    await this.save();
    logger.info(`✓ 已添加外部上游渠道: ${newChannel.name} (${newChannel.baseUrl})`);
    return newChannel;
  }

  /**
   * 更新渠道配置
   */
  async updateChannel(id, updates) {
    if (!this.initialized) await this.init();
    const index = this.channels.findIndex(c => c.id === id);
    if (index === -1) return null;

    const oldChannel = this.channels[index];
    const updatedChannel = {
      ...oldChannel,
      name: updates.name ?? oldChannel.name,
      type: updates.type ?? oldChannel.type,
      baseUrl: updates.baseUrl !== undefined ? (updates.baseUrl || '').replace(/\/+$/, '') : oldChannel.baseUrl,
      apiKey: updates.apiKey !== undefined ? updates.apiKey : oldChannel.apiKey,
      models: updates.models !== undefined 
        ? (Array.isArray(updates.models) ? updates.models : updates.models.split(',').map(m => m.trim()))
        : oldChannel.models,
      enable: updates.enable ?? oldChannel.enable,
      priority: updates.priority !== undefined ? Number(updates.priority) : oldChannel.priority,
      weight: updates.weight !== undefined ? Number(updates.weight) : oldChannel.weight,
      updatedAt: Date.now()
    };

    this.channels[index] = updatedChannel;
    await this.save();
    logger.info(`✓ 已更新外部上游渠道: ${updatedChannel.name}`);
    return updatedChannel;
  }

  /**
   * 删除渠道
   */
  async deleteChannel(id) {
    if (!this.initialized) await this.init();
    const index = this.channels.findIndex(c => c.id === id);
    if (index === -1) return false;

    const [deleted] = this.channels.splice(index, 1);
    await this.save();
    logger.info(`✓ 已删除外部上游渠道: ${deleted.name}`);
    return true;
  }

  /**
   * 记录渠道调用统计
   */
  async recordUsage(id, usage = null) {
    if (!id) return;
    if (!this.initialized) await this.init();
    const chan = this.channels.find(c => c.id === id);
    if (!chan) return;

    chan.totalRequests = (chan.totalRequests || 0) + 1;
    if (usage) {
      const input = usage.prompt_tokens || usage.input_tokens || usage.promptTokenCount || 0;
      const output = usage.completion_tokens || usage.output_tokens || usage.candidatesTokenCount || 0;
      const total = usage.total_tokens || usage.totalTokenCount || (input + output);
      chan.totalTokens = (chan.totalTokens || 0) + total;
    }
    chan.lastUsed = Date.now();
    await this.save();
  }

  /**
   * 筛选支持指定模型的可用外部渠道
   */
  async getAvailableChannelsForModel(model) {
    if (!this.initialized) await this.init();

    return this.channels.filter(c => {
      if (!c.enable) return false;
      if (!c.models || c.models.length === 0) return true; // 若未限制模型，则默认支持所有模型
      return c.models.some(m => m === '*' || m.toLowerCase() === model.toLowerCase() || model.toLowerCase().includes(m.toLowerCase()));
    }).sort((a, b) => (a.priority || 10) - (b.priority || 10));
  }

  /**
   * 获取下一个可用的外部渠道（按优先级和负载策略）
   */
  async getChannel(model) {
    const availableChannels = await this.getAvailableChannelsForModel(model);
    if (availableChannels.length === 0) return null;

    // 按模型记录轮询索引
    const idx = this.channelUsageIndices.get(model) || 0;
    const selected = availableChannels[idx % availableChannels.length];
    this.channelUsageIndices.set(model, (idx + 1) % availableChannels.length);
    return selected;
  }
}

const channelManager = new ChannelManager();
export default channelManager;
