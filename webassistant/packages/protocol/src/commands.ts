/**
 * Config command sets for anchors, tags and the robot chassis.
 *
 * The payload of a config frame is plain ASCII. These helpers wrap each
 * documented command so you get argument checking and a frame ready to write,
 * instead of hand-typing strings.
 *
 * Sources: [备注 3：基站配置命令集], [备注 4：标签配置命令集],
 * [备注 5：整机配置命令集] of the Jiuling AOA protocol document.
 *
 * Commands marked "弃用" (deprecated) in the document are still accepted by the
 * firmware and still occupy their argument slot, so they are kept here with
 * sensible defaults rather than removed.
 */

import { CmdDirect, CmdType, buildConfigFrame } from './protocol.js';

/** setcfg x7 -- report format. The binary protocol this package parses is 0. */
export const REPORT_FORMATS: Record<number, string> = {
  0: 'generic (binary protocol - use this)',
  1: 'JSON',
  2: 'car-follow',
  3: 'car-locate',
};

/** em_smode x1 */
export const ROBOT_MODES: Record<number, string> = {
  1: 'follow',
  2: 'calibration',
};

export interface CommandSetOptions {
  saddr?: bigint | number;
  daddr?: bigint | number;
  cmdDirect?: number;
}

/** Turns method calls into config frames of one `cmd_type`. */
abstract class CommandSet {
  protected abstract readonly cmdType: number;

  readonly saddr: bigint;
  readonly daddr: bigint;
  readonly cmdDirect: number;

  constructor(opts: CommandSetOptions = {}) {
    this.saddr = BigInt(opts.saddr ?? 0);
    this.daddr = BigInt(opts.daddr ?? 0);
    this.cmdDirect = opts.cmdDirect ?? CmdDirect.ENGINE_REQ;
  }

  /** Build a frame for an arbitrary command string. */
  raw(command: string): Uint8Array {
    return buildConfigFrame(this.cmdType, command, this.saddr, this.daddr, this.cmdDirect);
  }

  /** 复位 - reboot. */
  reset(): Uint8Array {
    return this.raw('reset');
  }

  /** 恢复出厂模式 - factory reset. */
  rtoken(): Uint8Array {
    return this.raw('rtoken');
  }

  /** 保存 - persist settings. */
  save(): Uint8Array {
    return this.raw('save');
  }

  /** 保存&复位 - persist and reboot. */
  saver(): Uint8Array {
    return this.raw('saver');
  }

  /** 获取版本 - read firmware version. */
  getver(): Uint8Array {
    return this.raw('getver');
  }
}

/** 基站配置命令集 - anchor commands (cmd_type 0x02). */
export class Anchor extends CommandSet {
  protected readonly cmdType = CmdType.ANCHOR_CFG;

  /**
   * 设置配置 - the main anchor configuration.
   *
   * Example from the document: `setcfg 1 1 1111 1 100 1 0`
   *
   * @param discoverTags 发现标签数量, 1-4
   * @param bindTags     绑定标签数量, 1-4
   * @param panId        个人网络 ID, 0-0xFFFE
   * @param anchorId     基站 ID, 0-3
   * @param refresh      刷新速率 (deprecated, kept as a positional slot)
   * @param filt         滤波设置 (deprecated, kept as a positional slot)
   * @param reportFormat 上报格式 -- see REPORT_FORMATS. Leave at 0 for the
   *                     binary protocol this package decodes.
   */
  setcfg(
    discoverTags: number,
    bindTags: number,
    panId: number,
    anchorId: number,
    refresh = 100,
    filt = 1,
    reportFormat = 0,
  ): Uint8Array {
    if (!(discoverTags >= 1 && discoverTags <= 4)) throw new RangeError('discoverTags must be 1-4');
    if (!(bindTags >= 1 && bindTags <= 4)) throw new RangeError('bindTags must be 1-4');
    if (!(panId >= 0 && panId <= 0xfffe)) throw new RangeError('panId must be 0-0xFFFE');
    if (!(anchorId >= 0 && anchorId <= 3)) throw new RangeError('anchorId must be 0-3');
    if (!(reportFormat in REPORT_FORMATS)) {
      throw new RangeError(`reportFormat must be one of ${Object.keys(REPORT_FORMATS).join(', ')}`);
    }
    const pan = panId.toString(16);
    return this.raw(
      `setcfg ${discoverTags} ${bindTags} ${pan} ${anchorId} ${refresh} ${filt} ${reportFormat}`,
    );
  }

  /** 获取配置. */
  getcfg(): Uint8Array {
    return this.raw('getcfg');
  }

  /**
   * 设置时间槽周期 - slot period in ms; refresh rate is 1000/ms Hz.
   * `setslot 10` gives a 10 ms slot, i.e. a 100 Hz update rate.
   */
  setslot(ms: number): Uint8Array {
    if (!(ms > 0)) throw new RangeError('slot period must be positive');
    return this.raw(`setslot ${ms}`);
  }

  /** 获取时间槽周期. */
  getslot(): Uint8Array {
    return this.raw('getslot');
  }

  /**
   * 设置硬件滤波参数.
   * @param enable 是否开启硬件滤波
   * @param coeff  硬件滤波系数, 2-50
   */
  setfilter(enable: boolean, coeff = 30): Uint8Array {
    if (!(coeff >= 2 && coeff <= 50)) throw new RangeError('filter coefficient must be 2-50');
    return this.raw(`setfilter ${enable ? 1 : 0} ${coeff}`);
  }

  /** 获取硬件滤波参数. */
  getfilter(): Uint8Array {
    return this.raw('getfilter');
  }

  /**
   * 绑定标签 - bind a tag.
   *
   * Example from the document: `addtag 10205FA01000154F 154F 0001 000A 00`
   */
  addtag(
    longAddr: bigint | number,
    shortAddr: number,
    fastest = 0x0001,
    slowest = 0x000a,
    mode = 0,
  ): Uint8Array {
    const la = BigInt(longAddr).toString(16).toUpperCase().padStart(16, '0');
    const sa = shortAddr.toString(16).toUpperCase().padStart(4, '0');
    const fa = fastest.toString(16).toUpperCase().padStart(4, '0');
    const sl = slowest.toString(16).toUpperCase().padStart(4, '0');
    const md = mode.toString(16).toUpperCase().padStart(2, '0');
    return this.raw(`addtag ${la} ${sa} ${fa} ${sl} ${md}`);
  }

  /** 删除标签 - unbind a tag by its 64-bit long address. */
  deltag(longAddr: bigint | number): Uint8Array {
    return this.raw(`deltag ${BigInt(longAddr).toString(16).toUpperCase().padStart(16, '0')}`);
  }

  /** 获取已经配对的标签列表 - list bound tags. */
  getklist(): Uint8Array {
    return this.raw('getklist');
  }

  /** 获取请求加入的标签列表 - list tags asking to join. */
  getdlist(): Uint8Array {
    return this.raw('getdlist');
  }

  /** 整机写入 360 度角度 - driven by the robot chassis, anchor A0 only. */
  retpara(tagShortAddr: number, region: number, degree: number): Uint8Array {
    const sa = tagShortAddr.toString(16).toUpperCase().padStart(4, '0');
    return this.raw(`retpara ${sa} ${region} ${degree}`);
  }
}

/** 标签配置命令集 - tag commands (cmd_type 0x03). */
export class Tag extends CommandSet {
  protected readonly cmdType = CmdType.TAG_CFG;

  /** 获取标签 ID. */
  getid(): Uint8Array {
    return this.raw('getid');
  }

  /** 获取标签类型 - 0 learn-board, 1 wristband, 2 remote. */
  gettype(): Uint8Array {
    return this.raw('gettype');
  }

  /**
   * 设置标签参数.
   *
   * Example from the document: `settag 90 110 10 1 3.50 1 1f 10`
   */
  settag(
    accMin = 90,
    accMax = 110,
    stillCount = 10,
    workWhileCharging = false,
    alarmVoltage = 3.5,
    paEnable = false,
    uwbPower = 0x1f,
    rebindRetries = 10,
  ): Uint8Array {
    return this.raw(
      `settag ${accMin} ${accMax} ${stillCount} ${workWhileCharging ? 1 : 0} ` +
        `${alarmVoltage.toFixed(2)} ${paEnable ? 1 : 0} ${uwbPower.toString(16)} ${rebindRetries}`,
    );
  }

  /** 获取标签参数. */
  gettag(): Uint8Array {
    return this.raw('gettag');
  }
}

/** 整机配置命令集 - whole-machine / chassis commands (cmd_type 0x05). */
export class Robot extends CommandSet {
  protected readonly cmdType = CmdType.ROBOT_CFG;

  override reset(): Uint8Array {
    return this.raw('em_reset');
  }

  override rtoken(): Uint8Array {
    return this.raw('em_rtoken');
  }

  override save(): Uint8Array {
    return this.raw('em_save');
  }

  override saver(): Uint8Array {
    return this.raw('em_saver');
  }

  override getver(): Uint8Array {
    return this.raw('em_getver');
  }

  /** 设置整机模式 - 1 follow (跟随模式), 2 calibration (标定模式). */
  smode(mode: number): Uint8Array {
    if (!(mode in ROBOT_MODES)) {
      throw new RangeError(`mode must be one of ${Object.keys(ROBOT_MODES).join(', ')}`);
    }
    return this.raw(`em_smode ${mode}`);
  }

  /** 读取整机模式. */
  gmode(): Uint8Array {
    return this.raw('em_gmode');
  }
}

export type CommandTarget = 'anchor' | 'tag' | 'robot';

export const CMD_TYPE_FOR_TARGET: Record<CommandTarget, number> = {
  anchor: CmdType.ANCHOR_CFG,
  tag: CmdType.TAG_CFG,
  robot: CmdType.ROBOT_CFG,
};

/** A documented command, for building the UI palette. */
export interface CommandSpec {
  target: CommandTarget;
  command: string;
  label: string;
  /** true when the command writes to the device */
  writes: boolean;
  /** the argument template shown to the user, if any */
  args?: string;
}

/**
 * The documented command catalogue, flattened for a picker. Kept as data rather
 * than reflection so the UI can show the Chinese label next to each command.
 */
export const COMMAND_CATALOG: CommandSpec[] = [
  { target: 'anchor', command: 'getcfg', label: '获取配置 - read config', writes: false },
  {
    target: 'anchor',
    command: 'setcfg',
    label: '设置配置 - write config',
    writes: true,
    args: '1 1 1111 1 100 1 0',
  },
  { target: 'anchor', command: 'getslot', label: '获取时间槽周期 - read slot period', writes: false },
  { target: 'anchor', command: 'setslot', label: '设置时间槽周期 - slot period (ms)', writes: true, args: '10' },
  { target: 'anchor', command: 'getfilter', label: '获取硬件滤波参数 - read filter', writes: false },
  { target: 'anchor', command: 'setfilter', label: '设置硬件滤波参数 - write filter', writes: true, args: '1 30' },
  { target: 'anchor', command: 'getklist', label: '获取已配对标签列表 - bound tags', writes: false },
  { target: 'anchor', command: 'getdlist', label: '获取请求加入标签列表 - joining tags', writes: false },
  {
    target: 'anchor',
    command: 'addtag',
    label: '绑定标签 - bind tag',
    writes: true,
    args: '10205FA01000154F 154F 0001 000A 00',
  },
  { target: 'anchor', command: 'deltag', label: '删除标签 - unbind tag', writes: true, args: '10205FA01000154F' },
  { target: 'anchor', command: 'getver', label: '获取版本 - firmware version', writes: false },
  { target: 'anchor', command: 'save', label: '保存 - persist', writes: true },
  { target: 'anchor', command: 'saver', label: '保存&复位 - persist + reboot', writes: true },
  { target: 'anchor', command: 'reset', label: '复位 - reboot', writes: true },
  { target: 'anchor', command: 'rtoken', label: '恢复出厂模式 - factory reset', writes: true },

  { target: 'tag', command: 'getid', label: '获取标签 ID', writes: false },
  { target: 'tag', command: 'gettype', label: '获取标签类型', writes: false },
  { target: 'tag', command: 'gettag', label: '获取标签参数', writes: false },
  { target: 'tag', command: 'settag', label: '设置标签参数', writes: true, args: '90 110 10 1 3.50 1 1f 10' },
  { target: 'tag', command: 'getver', label: '获取版本', writes: false },
  { target: 'tag', command: 'save', label: '保存', writes: true },
  { target: 'tag', command: 'saver', label: '保存&复位', writes: true },
  { target: 'tag', command: 'reset', label: '复位', writes: true },

  { target: 'robot', command: 'em_gmode', label: '读取整机模式 - read mode', writes: false },
  { target: 'robot', command: 'em_smode', label: '设置整机模式 - 1 follow / 2 calibration', writes: true, args: '1' },
  { target: 'robot', command: 'em_getver', label: '获取版本', writes: false },
  { target: 'robot', command: 'em_save', label: '保存', writes: true },
  { target: 'robot', command: 'em_saver', label: '保存&复位', writes: true },
  { target: 'robot', command: 'em_reset', label: '复位', writes: true },
];
