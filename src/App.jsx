import { useState, useEffect, useReducer, useCallback, useRef } from 'react';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const SIM_DURATION = 600;
const ORDER_INTERVAL = 60;
const OVEN_CAPACITY = 8;
const SECOND_OVEN_COST = 2000;
const EXPIRED_PENALTY = 50;
const QA_TIME = 5;

const CHIP_TYPES = {
  ALPHA: { name: 'ALPHA', label: 'The Basic', shape: 'square', colors: ['#EF4444', '#FFFFFF'], colorNames: ['Red', 'White'], pieces: 4, assemblyTime: 15, ovenTime: 10, value: 100, piecesNeeded: { Red: 2, White: 2 } },
  BETA: { name: 'BETA', label: 'The Pro', shape: 'rectangle', colors: ['#3B82F6', '#EAB308'], colorNames: ['Blue', 'Yellow'], pieces: 8, assemblyTime: 25, ovenTime: 15, value: 250, piecesNeeded: { Blue: 4, Yellow: 4 } },
  GAMMA: { name: 'GAMMA', label: 'The Elite', shape: 'lshape', colors: ['#1F2937', '#22C55E', '#9CA3AF'], colorNames: ['Black', 'Green', 'Silver'], pieces: 12, assemblyTime: 40, ovenTime: 20, value: 500, piecesNeeded: { Black: 4, Green: 4, Silver: 4 } },
};

const URGENCY_TYPES = {
  STANDARD: { label: 'STANDARD', expiry: 180, multiplier: 1.0, color: '#8B949E' },
  EXPRESS: { label: 'EXPRESS', expiry: 90, multiplier: 1.5, color: '#F85149' },
  BULK: { label: 'BULK', expiry: 300, multiplier: 0.8, color: '#3B82F6' },
};

const STAGES = [
  { id: 'warehouse', name: 'WAREHOUSE', shortName: 'WH', maxOps: 2, icon: '📦' },
  { id: 'assembly', name: 'ASSEMBLY', shortName: 'ASM', maxOps: 3, icon: '🔧' },
  { id: 'oven', name: 'OVEN', shortName: 'OVN', maxOps: 2, icon: '🔥' },
  { id: 'qa', name: 'QA', shortName: 'QA', maxOps: 1, icon: '✅' },
  { id: 'logistics', name: 'LOGISTICS', shortName: 'LOG', maxOps: 1, icon: '🚚' },
];

const INITIAL_STOCK = { Red: 80, White: 80, Blue: 60, Yellow: 60, Black: 40, Green: 40, Silver: 40 };

// ─── BUILD PATTERNS (for interactive assembly) ──────────────────────────────
const BRICK_COLORS = { Red: '#EF4444', White: '#F8F8F8', Blue: '#3B82F6', Yellow: '#EAB308', Black: '#1F2937', Green: '#22C55E', Silver: '#9CA3AF' };

const BUILD_PATTERNS = {
  ALPHA: { grid: [['Red','White'],['White','Red']], rows: 2, cols: 2 },
  BETA: { grid: [['Blue','Yellow','Blue','Yellow'],['Yellow','Blue','Yellow','Blue']], rows: 2, cols: 4 },
  GAMMA: { grid: [['Black','Green','Silver','Black'],['Green','Silver','Black','Green'],['Silver','Black','Green','Silver']], rows: 3, cols: 4 },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const genId = () => Math.random().toString(36).substr(2, 9);
const formatTime = (seconds) => { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; };
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1 to avoid confusion
const generateRoomCode = () => Array.from({ length: 4 }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');
const getRoomFromURL = () => new URLSearchParams(window.location.search).get('room')?.toUpperCase() || null;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

function weightedChipType(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return 'ALPHA';
  let r = Math.random() * total;
  for (const [type, w] of entries) {
    r -= w;
    if (r <= 0) return type;
  }
  return entries[entries.length - 1][0];
}

function generateOrder(roundNumber, simTime, chipWeights) {
  const quantities = [2,4,6,8];
  const urgencies = ['STANDARD','EXPRESS','BULK'];
  const chipType = chipWeights ? weightedChipType(chipWeights) : ['ALPHA','BETA','GAMMA'][Math.floor(Math.random()*3)];
  const quantity = quantities[Math.floor(Math.random()*quantities.length)];
  const urgency = urgencies[Math.floor(Math.random()*urgencies.length)];
  const urgInfo = URGENCY_TYPES[urgency];
  return { id: genId(), orderNumber: roundNumber, chipType, quantity, urgency, createdAt: simTime, expiresAt: simTime + urgInfo.expiry, value: CHIP_TYPES[chipType].value * quantity * urgInfo.multiplier, status: 'pending', chipsProduced: 0, chipsWelded: 0, chipsInspected: 0 };
}

function canKitOrder(order, stock) {
  const chip = CHIP_TYPES[order.chipType];
  for (const [color, needed] of Object.entries(chip.piecesNeeded)) {
    if (stock[color] < needed * order.quantity) return false;
  }
  return true;
}

// ─── INITIAL STATE ───────────────────────────────────────────────────────────
function createInitialState(roomCode) {
  return {
    sessionId: roomCode || 'default', phase: 'lobby', startTime: null, elapsedTime: 0, round: 0, _sessionStart: null,
    stock: { ...INITIAL_STOCK }, stockMultiplier: 1.0, holdingCostRate: 0, holdingCostAccrued: 0, chipWeights: { ALPHA: 1, BETA: 1, GAMMA: 2 }, orders: [],
    warehouseQueue: [], assemblyInProgress: [], ovenQueue: [],
    ovens: [{ id: 'oven1', batch: [], running: false, startedAt: null, completesAt: null, weldTime: 0 }],
    hasSecondOven: false, ovenPurchaseTime: null,
    qaQueue: [], qaInProgress: [], finishedChips: [], shippedChips: [],
    operators: {}, stageAssignments: { warehouse: [], assembly: [], oven: [], qa: [], logistics: [] },
    revenue: 0, penalties: 0, ovenBatches: [], orderLeadTimes: [],
    stageIdleTime: { warehouse: 0, assembly: 0, oven: 0, qa: 0, logistics: 0 },
    alerts: [], lastOrderTime: 0, botTimers: { warehouse: 0, assembly: 0, oven: 0, logistics: 0 }, strategicChangesUsed: 0, maxStrategicChanges: 3, version: 0,
  };
}

// ─── REDUCER ─────────────────────────────────────────────────────────────────
function gameReducer(state, action) {
  switch (action.type) {
    case 'TICK': {
      if (state.phase !== 'running') return state;
      const now = action.elapsed;
      let s = { ...state, elapsedTime: now, version: state.version + 1 };
      if (now >= SIM_DURATION) return { ...s, phase: 'finished' };

      // Generate orders
      const currentRound = Math.floor(now / ORDER_INTERVAL) + 1;
      if (currentRound > s.round && s.round < 10) {
        const order = generateOrder(currentRound, now, s.chipWeights);
        s = { ...s, round: currentRound, orders: [...s.orders, order], lastOrderTime: now };
        s.alerts = [...s.alerts, { id: genId(), msg: `New order #${order.orderNumber}: ${order.chipType}×${order.quantity} (${order.urgency})`, time: now, type: 'order' }].slice(-10);
      }

      // Expire orders
      s.orders = s.orders.map(o => {
        if (o.status !== 'shipped' && o.status !== 'expired' && now >= o.expiresAt) {
          s.penalties += EXPIRED_PENALTY;
          s.alerts = [...s.alerts, { id: genId(), msg: `Order #${o.orderNumber} EXPIRED! -$${EXPIRED_PENALTY}`, time: now, type: 'danger' }].slice(-10);
          return { ...o, status: 'expired' };
        }
        return o;
      });

      // Process assembly completions (bots)
      s.assemblyInProgress = s.assemblyInProgress.filter(a => {
        if (now >= a.completesAt) {
          s.ovenQueue = [...s.ovenQueue, { id: a.chipId, chipType: a.chipType, orderId: a.orderId }];
          return false;
        }
        return true;
      });

      // Process oven completions
      s.ovens = s.ovens.map(oven => {
        if (oven.running && now >= oven.completesAt) {
          s.qaQueue = [...s.qaQueue, ...oven.batch.map(c => ({ ...c }))];
          s.ovenBatches = [...s.ovenBatches, { size: oven.batch.length, weldTime: oven.weldTime }];
          return { ...oven, batch: [], running: false, startedAt: null, completesAt: null, weldTime: 0 };
        }
        return oven;
      });

      // Process QA completions
      s.qaInProgress = s.qaInProgress.filter(q => {
        if (now >= q.completesAt) {
          s.finishedChips = [...s.finishedChips, { id: q.chipId, chipType: q.chipType, orderId: q.orderId }];
          s.orders = s.orders.map(o => o.id === q.orderId ? { ...o, chipsInspected: o.chipsInspected + 1 } : o);
          return false;
        }
        return true;
      });

      // Auto-start QA
      const qaOps = s.stageAssignments.qa.length;
      if (qaOps > 0 && s.qaQueue.length > 0 && s.qaInProgress.length < qaOps) {
        const toProcess = Math.min(s.qaQueue.length, qaOps - s.qaInProgress.length);
        for (let i = 0; i < toProcess; i++) {
          const chip = s.qaQueue[i];
          s.qaInProgress = [...s.qaInProgress, { chipId: chip.id, chipType: chip.chipType, orderId: chip.orderId, startedAt: now, completesAt: now + QA_TIME }];
        }
        s.qaQueue = s.qaQueue.slice(toProcess);
      }

      // ── BOT AUTO-PROCESSING ──
      const hasBot = (stageId) => s.stageAssignments[stageId].some(opId => s.operators[opId]?.isBot);
      const bt = { ...s.botTimers };

      // Bot Warehouse: kit every 4 seconds
      if (hasBot('warehouse') && now - bt.warehouse >= 4) {
        const pendingOrder = s.orders.find(o => o.status === 'pending' && o.expiresAt > now && canKitOrder(o, s.stock));
        if (pendingOrder) {
          const chip = CHIP_TYPES[pendingOrder.chipType];
          const newStock = { ...s.stock };
          for (const [color, needed] of Object.entries(chip.piecesNeeded)) newStock[color] -= needed * pendingOrder.quantity;
          const newChips = Array.from({ length: pendingOrder.quantity }, () => ({ id: genId(), chipType: pendingOrder.chipType, orderId: pendingOrder.id }));
          s.stock = newStock;
          s.warehouseQueue = [...s.warehouseQueue, ...newChips];
          s.orders = s.orders.map(o => o.id === pendingOrder.id ? { ...o, status: 'in_production' } : o);
          const alerts = [];
          for (const [color, amount] of Object.entries(newStock)) {
            if (amount < 20 && state.stock[color] >= 20) alerts.push({ id: genId(), msg: `LOW STOCK: ${color} at ${amount}!`, time: now, type: 'warning' });
          }
          if (alerts.length) s.alerts = [...s.alerts, ...alerts].slice(-10);
        }
        bt.warehouse = now;
      }

      // Bot Assembly: auto-start assembly
      if (hasBot('assembly') && now - bt.assembly >= 2) {
        const botSlots = s.stageAssignments.assembly.filter(id => s.operators[id]?.isBot).length;
        const slotsAvail = botSlots - s.assemblyInProgress.length;
        if (slotsAvail > 0 && s.warehouseQueue.length > 0) {
          const toAssemble = s.warehouseQueue.slice(0, slotsAvail);
          s.warehouseQueue = s.warehouseQueue.slice(slotsAvail);
          const newIP = toAssemble.map(c => ({ chipId: c.id, chipType: c.chipType, orderId: c.orderId, startedAt: now, completesAt: now + CHIP_TYPES[c.chipType].assemblyTime }));
          s.assemblyInProgress = [...s.assemblyInProgress, ...newIP];
        }
        bt.assembly = now;
      }

      // Bot Oven: auto-load when queue >= 4 or waiting > 15s
      if (hasBot('oven') && now - bt.oven >= 3) {
        for (const oven of s.ovens) {
          if (!oven.running && s.ovenQueue.length > 0) {
            const shouldFire = s.ovenQueue.length >= 4 || (s.ovenQueue.length > 0 && now - bt.oven >= 15);
            if (shouldFire) {
              const chips = s.ovenQueue.slice(0, OVEN_CAPACITY);
              const chipIds = chips.map(c => c.id);
              const maxWeld = Math.max(...chips.map(c => CHIP_TYPES[c.chipType].ovenTime));
              const ovenIdx = s.ovens.findIndex(o => o.id === oven.id);
              s.ovens = [...s.ovens];
              s.ovens[ovenIdx] = { ...oven, batch: chips, running: true, startedAt: now, completesAt: now + maxWeld, weldTime: maxWeld };
              s.ovenQueue = s.ovenQueue.filter(c => !chipIds.includes(c.id));
              chips.forEach(chip => { s.orders = s.orders.map(o => o.id === chip.orderId ? { ...o, chipsWelded: o.chipsWelded + 1 } : o); });
              break;
            }
          }
        }
        bt.oven = now;
      }

      // Bot Logistics: auto-ship
      if (hasBot('logistics') && now - bt.logistics >= 2) {
        const shippable = s.orders.find(o => {
          if (o.status === 'shipped' || o.status === 'expired') return false;
          return s.finishedChips.filter(c => c.orderId === o.id).length >= o.quantity;
        });
        if (shippable) {
          const matching = s.finishedChips.filter(c => c.orderId === shippable.id).slice(0, shippable.quantity);
          const ids = matching.map(c => c.id);
          s.finishedChips = s.finishedChips.filter(c => !ids.includes(c.id));
          s.shippedChips = [...s.shippedChips, ...ids.map(id => ({ id }))];
          s.orders = s.orders.map(o => o.id === shippable.id ? { ...o, status: 'shipped' } : o);
          s.revenue += shippable.value;
          s.orderLeadTimes = [...s.orderLeadTimes, now - shippable.createdAt];
          s.alerts = [...s.alerts, { id: genId(), msg: `Order #${shippable.orderNumber} shipped! +$${shippable.value}`, time: now, type: 'success' }].slice(-10);
        }
        bt.logistics = now;
      }

      s.botTimers = bt;

      // Track idle time
      for (const stage of STAGES) {
        const hasOps = s.stageAssignments[stage.id].length > 0;
        let isIdle = false;
        if (stage.id === 'warehouse') isIdle = hasOps && s.orders.filter(o => o.status === 'pending').length === 0;
        if (stage.id === 'assembly') isIdle = hasOps && s.warehouseQueue.length === 0 && s.assemblyInProgress.length === 0;
        if (stage.id === 'oven') isIdle = hasOps && s.ovenQueue.length === 0 && s.ovens.every(o => !o.running);
        if (stage.id === 'qa') isIdle = hasOps && s.qaQueue.length === 0 && s.qaInProgress.length === 0;
        if (stage.id === 'logistics') isIdle = hasOps && s.finishedChips.length === 0;
        if (isIdle) s.stageIdleTime = { ...s.stageIdleTime, [stage.id]: s.stageIdleTime[stage.id] + 1 };
      }

      // Holding cost: drain cash per tick based on total inventory
      if (s.holdingCostRate > 0) {
        const totalBricks = Object.values(s.stock).reduce((sum, v) => sum + v, 0);
        const cost = totalBricks * s.holdingCostRate;
        s.holdingCostAccrued = (s.holdingCostAccrued || 0) + cost;
        s.penalties += cost;
      }

      return s;
    }

    case 'START_STAGING': {
      return { ...state, phase: 'staging', _sessionStart: Date.now(), strategicChangesUsed: 0, version: state.version + 1 };
    }
    case 'START_SIMULATION': {
      const first = generateOrder(1, 0);
      return { ...state, phase: 'running', startTime: Date.now(), _sessionStart: state._sessionStart || Date.now(), round: 1, orders: [first], alerts: [{ id: genId(), msg: `Simulation started! First order: ${first.chipType}×${first.quantity}`, time: 0, type: 'order' }], version: state.version + 1 };
    }

    case 'ASSIGN_OPERATOR': {
      const { operatorId, fromStage, toStage } = action;
      // During running phase, reassigning (fromStage → toStage) costs a strategic change
      const isReassign = state.phase === 'running' && fromStage;
      if (isReassign && state.strategicChangesUsed >= state.maxStrategicChanges) return state;
      const na = { ...state.stageAssignments };
      if (fromStage) na[fromStage] = na[fromStage].filter(id => id !== operatorId);
      if (toStage && !na[toStage].includes(operatorId)) {
        const si = STAGES.find(s => s.id === toStage);
        if (na[toStage].length < si.maxOps) na[toStage] = [...na[toStage], operatorId];
      }
      return { ...state, stageAssignments: na, strategicChangesUsed: state.strategicChangesUsed + (isReassign ? 1 : 0), version: state.version + 1 };
    }

    case 'KIT_CHIPS': {
      const { chipType, quantity, orderId } = action;
      const chip = CHIP_TYPES[chipType];
      const ns = { ...state.stock };
      for (const [c, n] of Object.entries(chip.piecesNeeded)) { if (ns[c] < n * quantity) return state; }
      for (const [c, n] of Object.entries(chip.piecesNeeded)) ns[c] -= n * quantity;
      const nc = Array.from({ length: quantity }, () => ({ id: genId(), chipType, orderId }));
      const no = state.orders.map(o => o.id === orderId ? { ...o, status: 'in_production' } : o);
      const al = [];
      for (const [c, a] of Object.entries(ns)) { if (a < 20 && state.stock[c] >= 20) al.push({ id: genId(), msg: `LOW STOCK: ${c} at ${a}!`, time: state.elapsedTime, type: 'warning' }); }
      return { ...state, stock: ns, warehouseQueue: [...state.warehouseQueue, ...nc], orders: no, alerts: [...state.alerts, ...al].slice(-10), version: state.version + 1 };
    }

    case 'CLAIM_FOR_ASSEMBLY': {
      const idx = state.warehouseQueue.findIndex(c => c.id === action.chipId);
      if (idx === -1) return state;
      return { ...state, warehouseQueue: state.warehouseQueue.filter((_, i) => i !== idx), version: state.version + 1 };
    }

    case 'COMPLETE_HUMAN_ASSEMBLY': {
      return { ...state, ovenQueue: [...state.ovenQueue, { id: action.chipId, chipType: action.chipType, orderId: action.orderId }], version: state.version + 1 };
    }

    case 'LOAD_OVEN': {
      const { ovenId, chipIds } = action;
      const oi = state.ovens.findIndex(o => o.id === ovenId);
      if (oi === -1) return state;
      const oven = state.ovens[oi];
      if (oven.running || state.stageAssignments.oven.length === 0) return state;
      const sel = chipIds.map(id => state.ovenQueue.find(c => c.id === id)).filter(Boolean).slice(0, OVEN_CAPACITY);
      if (!sel.length) return state;
      const mw = Math.max(...sel.map(c => CHIP_TYPES[c.chipType].ovenTime));
      const no = [...state.ovens]; no[oi] = { ...oven, batch: sel, running: true, startedAt: state.elapsedTime, completesAt: state.elapsedTime + mw, weldTime: mw };
      const rq = state.ovenQueue.filter(c => !chipIds.includes(c.id));
      const nord = [...state.orders]; sel.forEach(ch => { const x = nord.findIndex(o => o.id === ch.orderId); if (x !== -1) nord[x] = { ...nord[x], chipsWelded: nord[x].chipsWelded + 1 }; });
      return { ...state, ovens: no, ovenQueue: rq, orders: nord, version: state.version + 1 };
    }

    case 'LOAD_OVEN_ALL': {
      const { ovenId } = action;
      const oi = state.ovens.findIndex(o => o.id === ovenId);
      if (oi === -1) return state;
      if (state.ovens[oi].running || state.stageAssignments.oven.length === 0) return state;
      const chips = state.ovenQueue.slice(0, OVEN_CAPACITY);
      if (!chips.length) return state;
      return gameReducer(state, { type: 'LOAD_OVEN', ovenId, chipIds: chips.map(c => c.id) });
    }

    case 'BUY_SECOND_OVEN': {
      if (state.hasSecondOven || state.elapsedTime < 180) return state;
      if (state.strategicChangesUsed >= state.maxStrategicChanges) return state;
      return { ...state, hasSecondOven: true, ovenPurchaseTime: state.elapsedTime, ovens: [...state.ovens, { id: 'oven2', batch: [], running: false, startedAt: null, completesAt: null, weldTime: 0 }], alerts: [...state.alerts, { id: genId(), msg: '2nd Oven purchased! -$2,000 (1 strategic change used)', time: state.elapsedTime, type: 'warning' }].slice(-10), strategicChangesUsed: state.strategicChangesUsed + 1, version: state.version + 1 };
    }

    case 'SHIP_ORDER': {
      const { orderId } = action;
      const order = state.orders.find(o => o.id === orderId);
      if (!order || order.status === 'shipped' || order.status === 'expired') return state;
      if (state.stageAssignments.logistics.length === 0) return state;
      const mc = state.finishedChips.filter(c => c.orderId === orderId);
      if (mc.length < order.quantity) return state;
      const ids = mc.slice(0, order.quantity).map(c => c.id);
      const lt = state.elapsedTime - order.createdAt;
      return { ...state, finishedChips: state.finishedChips.filter(c => !ids.includes(c.id)), shippedChips: [...state.shippedChips, ...ids.map(id => ({ id }))], orders: state.orders.map(o => o.id === orderId ? { ...o, status: 'shipped' } : o), revenue: state.revenue + order.value, orderLeadTimes: [...state.orderLeadTimes, lt], alerts: [...state.alerts, { id: genId(), msg: `Order #${order.orderNumber} shipped! +$${order.value}`, time: state.elapsedTime, type: 'success' }].slice(-10), version: state.version + 1 };
    }

    case 'ADD_OPERATOR': {
      const { id, name, stage, isBot } = action;
      const newOps = { ...state.operators, [id]: { name, stage, busy: false, isBot: !!isBot } };
      const na = { ...state.stageAssignments };
      if (stage && !na[stage].includes(id)) na[stage] = [...na[stage], id];
      return { ...state, operators: newOps, stageAssignments: na, version: state.version + 1 };
    }

    case 'SEND_ALERT': {
      return { ...state, alerts: [...state.alerts, { id: genId(), msg: action.msg, time: state.elapsedTime, type: action.alertType || 'info' }].slice(-10), version: state.version + 1 };
    }

    case 'SET_GAME_CONFIG': {
      const updates = {};
      if (action.chipWeights !== undefined) updates.chipWeights = action.chipWeights;
      if (action.holdingCostRate !== undefined) updates.holdingCostRate = action.holdingCostRate;
      if (action.stockMultiplier !== undefined) {
        updates.stockMultiplier = action.stockMultiplier;
        const newStock = {};
        for (const [color, base] of Object.entries(INITIAL_STOCK)) {
          newStock[color] = Math.round(base * action.stockMultiplier);
        }
        updates.stock = newStock;
      }
      return { ...state, ...updates, version: state.version + 1 };
    }

    case 'INJECT_ORDER': {
      if (state.phase !== 'running') return state;
      const order = generateOrder(state.round + 0.5, state.elapsedTime, state.chipWeights);
      if (action.chipType) { order.chipType = action.chipType; order.quantity = action.quantity || order.quantity; }
      if (action.urgency) { order.urgency = action.urgency; order.expiresAt = state.elapsedTime + URGENCY_TYPES[action.urgency].expiry; }
      order.value = CHIP_TYPES[order.chipType].value * order.quantity * URGENCY_TYPES[order.urgency].multiplier;
      return { ...state, orders: [...state.orders, order], alerts: [...state.alerts, { id: genId(), msg: `TEACHER injected: ${order.chipType}×${order.quantity} (${order.urgency})`, time: state.elapsedTime, type: 'warning' }].slice(-10), version: state.version + 1 };
    }

    case 'PAUSE_SIMULATION': {
      if (state.phase !== 'running') return state;
      return { ...state, phase: 'paused', _pausedAt: Date.now(), version: state.version + 1 };
    }

    case 'RESUME_SIMULATION': {
      if (state.phase !== 'paused') return state;
      const pauseDuration = Date.now() - state._pausedAt;
      return { ...state, phase: 'running', startTime: state.startTime + pauseDuration, _pausedAt: null, version: state.version + 1 };
    }

    case 'SET_STATE': return action.state;
    default: return state;
  }
}

// ─── CHIP SVG COMPONENTS ────────────────────────────────────────────────────
function ChipIcon({ chipType, size = 24 }) {
  if (chipType === 'ALPHA') return (
    <svg width={size} height={size} viewBox="0 0 28 28">
      <rect x="2" y="2" width="24" height="24" rx="2" fill="#EF4444" stroke="#B91C1C" strokeWidth="1.5"/>
      <rect x="6" y="6" width="7" height="7" rx="1" fill="#FFF" opacity="0.9"/><rect x="15" y="6" width="7" height="7" rx="1" fill="#FFF" opacity="0.9"/>
      <rect x="6" y="15" width="7" height="7" rx="1" fill="#FFF" opacity="0.9"/><rect x="15" y="15" width="7" height="7" rx="1" fill="#FFF" opacity="0.9"/>
      <circle cx="9.5" cy="9.5" r="2" fill="#EF4444" opacity="0.6"/><circle cx="18.5" cy="9.5" r="2" fill="#EF4444" opacity="0.6"/>
      <circle cx="9.5" cy="18.5" r="2" fill="#EF4444" opacity="0.6"/><circle cx="18.5" cy="18.5" r="2" fill="#EF4444" opacity="0.6"/>
    </svg>
  );
  if (chipType === 'BETA') return (
    <svg width={size * 2} height={size} viewBox="0 0 56 28">
      <rect x="2" y="2" width="52" height="24" rx="2" fill="#3B82F6" stroke="#1D4ED8" strokeWidth="1.5"/>
      {[0,1,2,3].map(i => <g key={i}><rect x={6+i*12.5} y="6" width="9" height="7" rx="1" fill="#EAB308" opacity="0.9"/><rect x={6+i*12.5} y="15" width="9" height="7" rx="1" fill="#EAB308" opacity="0.9"/></g>)}
    </svg>
  );
  if (chipType === 'GAMMA') return (
    <svg width={size*1.2} height={size*1.2} viewBox="0 0 34 34">
      <path d="M4 4 H30 V30 H16 V16 H4 Z" fill="#1F2937" stroke="#111827" strokeWidth="1.5"/>
      <rect x="7" y="7" width="6" height="6" rx="1" fill="#22C55E" opacity="0.9"/><rect x="16" y="7" width="6" height="6" rx="1" fill="#9CA3AF" opacity="0.9"/>
      <rect x="16" y="16" width="6" height="6" rx="1" fill="#22C55E" opacity="0.9"/><rect x="25" y="16" width="5" height="6" rx="1" fill="#9CA3AF" opacity="0.9"/>
      <rect x="16" y="25" width="6" height="5" rx="1" fill="#9CA3AF" opacity="0.9"/><rect x="25" y="25" width="5" height="5" rx="1" fill="#22C55E" opacity="0.9"/>
    </svg>
  );
  return null;
}

// ─── UTILITY COMPONENTS ──────────────────────────────────────────────────────
function ProgressBar({ value, max, color = '#F0B429', height = 'h-2' }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return <div className={`w-full bg-[#21262D] rounded-full ${height}`}><div className="rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color, height: '100%' }} /></div>;
}

function StageQueueBar({ queueLength }) {
  const blocks = Math.min(queueLength, 8);
  return <div className="flex gap-0.5">{Array.from({ length: 8 }, (_, i) => <div key={i} className={`w-3 h-4 rounded-sm transition-all ${i < blocks ? (queueLength > 6 ? 'bg-[#F85149]' : queueLength > 3 ? 'bg-[#F0B429]' : 'bg-[#3FB950]') : 'bg-[#21262D]'}`} />)}</div>;
}

function AlertBanner({ alerts }) {
  if (!alerts.length) return null;
  const l = alerts[alerts.length - 1];
  const c = { order: 'border-cyan', warning: 'border-amber', danger: 'border-[#F85149]', success: 'border-[#3FB950]', info: 'border-[#8B949E]' };
  return <div className={`border-l-2 ${c[l.type] || 'border-[#8B949E]'} bg-[#161B22] px-3 py-1.5 text-xs font-mono animate-slide-in`}>{l.msg}</div>;
}

// ─── OVEN DISPLAY ────────────────────────────────────────────────────────────
function OvenDisplay({ oven, elapsed, onLoadAll, interactive }) {
  const isRunning = oven.running;
  const progress = isRunning ? Math.min((elapsed - oven.startedAt) / oven.weldTime, 1) : 0;
  const remaining = isRunning ? Math.max(0, oven.completesAt - elapsed) : 0;
  return (
    <div className={`border rounded-lg p-3 ${isRunning ? 'border-[#F0B429] animate-pulse-glow animate-oven-heat' : 'border-[#30363D] bg-[#161B22]'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-[#8B949E] uppercase tracking-wider">{oven.id === 'oven1' ? 'Oven 1' : 'Oven 2'}</span>
        {isRunning ? <span className="text-xs font-mono text-[#F0B429]">{formatTime(remaining)}</span> : <span className="text-xs text-[#8B949E]">IDLE</span>}
      </div>
      <div className="grid grid-cols-4 gap-1 mb-2">
        {Array.from({ length: OVEN_CAPACITY }, (_, i) => {
          const chip = oven.batch[i];
          return <div key={i} className={`aspect-square rounded flex items-center justify-center text-[10px] ${chip ? 'bg-[#21262D] border border-[#F0B429]/30' : 'bg-[#0D1117] border border-[#21262D]'}`}>{chip ? <ChipIcon chipType={chip.chipType} size={16} /> : <span className="text-[#30363D]">{i+1}</span>}</div>;
        })}
      </div>
      {isRunning && <ProgressBar value={progress * 100} max={100} color="#F0B429" />}
      {!isRunning && onLoadAll && <button onClick={() => onLoadAll(oven.id)} className="w-full py-1 text-xs font-bold bg-[#F0B429]/20 text-[#F0B429] border border-[#F0B429]/30 rounded hover:bg-[#F0B429]/30 transition-colors">LOAD & START</button>}
    </div>
  );
}

// ─── ORDER CARD ──────────────────────────────────────────────────────────────
function OrderCard({ order, elapsed, onShip, canShip }) {
  const remaining = Math.max(0, order.expiresAt - elapsed);
  const urgInfo = URGENCY_TYPES[order.urgency];
  const isExpired = order.status === 'expired', isShipped = order.status === 'shipped';
  const isUrgent = remaining < 30 && !isExpired && !isShipped;
  return (
    <div className={`border rounded-lg p-2.5 text-xs transition-all ${isShipped ? 'border-[#3FB950]/40 bg-[#3FB950]/5' : isExpired ? 'border-[#F85149]/40 bg-[#F85149]/5 opacity-50' : isUrgent ? 'border-[#F85149] bg-[#F85149]/5' : 'border-[#30363D] bg-[#161B22]'}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-white">#{order.orderNumber}</span>
          <ChipIcon chipType={order.chipType} size={16} />
          <span className="text-[#8B949E]">{order.chipType}×{order.quantity}</span>
        </div>
        <span className="font-mono px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ backgroundColor: urgInfo.color + '22', color: urgInfo.color }}>{urgInfo.label}</span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!isShipped && !isExpired && <span className={`font-mono ${isUrgent ? 'text-[#F85149]' : 'text-[#8B949E]'}`}>⏱ {formatTime(remaining)}</span>}
          <span className="font-mono text-[#F0B429]">${order.value.toLocaleString()}</span>
          <span className="text-[#8B949E]">{order.chipsInspected}/{order.quantity} done</span>
        </div>
        <div className="flex items-center gap-2">
          {isShipped && <span className="text-[#3FB950] font-bold">✓ SHIPPED</span>}
          {isExpired && <span className="text-[#F85149] font-bold">✗ EXPIRED</span>}
          {canShip && !isShipped && !isExpired && onShip && <button onClick={() => onShip(order.id)} className="px-2 py-0.5 bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/40 rounded text-[10px] font-bold hover:bg-[#3FB950]/30 transition-colors">SHIP</button>}
        </div>
      </div>
    </div>
  );
}

// ─── STAGE PANEL ─────────────────────────────────────────────────────────────
function StagePanel({ stage, state }) {
  const ops = state.stageAssignments[stage.id];
  let queueLength = 0, statusText = '', statusColor = '#3FB950';
  switch (stage.id) {
    case 'warehouse': queueLength = state.orders.filter(o => o.status === 'pending').length; statusText = `${queueLength} pending`; break;
    case 'assembly': queueLength = state.warehouseQueue.length; statusText = `${queueLength} kitted / ${state.assemblyInProgress.length} building`; break;
    case 'oven': queueLength = state.ovenQueue.length; statusText = `${queueLength} waiting / ${state.ovens.filter(o => o.running).length} running`; break;
    case 'qa': queueLength = state.qaQueue.length + state.qaInProgress.length; statusText = `${state.qaQueue.length} waiting / ${state.qaInProgress.length} inspecting`; break;
    case 'logistics': queueLength = state.finishedChips.length; statusText = `${queueLength} ready`; break;
  }
  if (queueLength > 6) statusColor = '#F85149'; else if (queueLength > 3) statusColor = '#F0B429';
  const noOps = ops.length === 0;
  const opNames = ops.map(id => state.operators[id]?.name || id);
  return (
    <div className={`bg-[#161B22] border rounded-lg p-3 transition-colors ${noOps ? 'border-[#F85149]/60 bg-[#F85149]/5' : 'border-[#30363D]'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2"><span className="text-lg">{stage.icon}</span><span className="text-xs font-bold uppercase tracking-wider text-white">{stage.name}</span></div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: noOps ? '#F85149' : statusColor }} /><span className={`text-[10px] font-mono ${noOps ? 'text-[#F85149] font-bold' : 'text-[#8B949E]'}`}>{noOps ? 'NO OPS' : `${ops.length}/${stage.maxOps}`}</span></div>
      </div>
      {noOps && <p className="text-[10px] text-[#F85149] mb-1.5 font-medium">Assign an operator</p>}
      {opNames.length > 0 && <div className="flex gap-1 mb-1.5 flex-wrap">{opNames.map((n, i) => <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${state.operators[ops[i]]?.isBot ? 'bg-cyan/15 text-cyan' : 'bg-[#3FB950]/15 text-[#3FB950]'}`}>{n}</span>)}</div>}
      <StageQueueBar queueLength={queueLength} />
      <p className="text-[10px] text-[#8B949E] mt-1 font-mono">{statusText}</p>
    </div>
  );
}

// ─── OPERATOR ASSIGNMENT ─────────────────────────────────────────────────────
function OperatorAssignment({ state, dispatch }) {
  const allOps = Object.entries(state.operators);
  const getStage = (id) => { for (const [s, ops] of Object.entries(state.stageAssignments)) if (ops.includes(id)) return s; return null; };
  const move = (id, to) => { const from = getStage(id); dispatch({ type: 'ASSIGN_OPERATOR', operatorId: id, fromStage: from, toStage: to }); };
  const unassigned = allOps.filter(([id]) => !getStage(id));
  const assigned = allOps.filter(([id]) => getStage(id));
  const humanOps = allOps.filter(([, op]) => !op.isBot);
  const botOps = allOps.filter(([, op]) => op.isBot);
  const emptyStages = STAGES.filter(s => state.stageAssignments[s.id].length === 0);
  const changesLeft = state.maxStrategicChanges - state.strategicChangesUsed;
  const noChanges = changesLeft <= 0;

  return (
    <div className={`bg-[#161B22] border rounded-xl p-4 transition-all ${unassigned.length > 0 ? 'border-[#F0B429] ring-1 ring-[#F0B429]/20' : 'border-[#30363D]'}`}>
      {/* Header with live counts */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">👥</span>
          <h3 className="text-sm font-bold text-white">Team Roster</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {humanOps.length > 0 && (
            <span className="text-[9px] font-bold bg-[#3FB950]/15 text-[#3FB950] px-1.5 py-0.5 rounded-full">
              {humanOps.length} human{humanOps.length !== 1 ? 's' : ''}
            </span>
          )}
          {botOps.length > 0 && (
            <span className="text-[9px] font-bold bg-cyan/15 text-cyan px-1.5 py-0.5 rounded-full">
              {botOps.length} bot{botOps.length !== 1 ? 's' : ''}
            </span>
          )}
          {unassigned.length > 0 && (
            <span className="text-[9px] font-bold bg-[#F0B429]/20 text-[#F0B429] px-1.5 py-0.5 rounded-full animate-pulse">
              {unassigned.length} idle
            </span>
          )}
        </div>
      </div>

      {/* No changes warning */}
      {noChanges && assigned.length > 0 && (
        <div className="bg-[#F85149]/10 border border-[#F85149]/30 rounded-lg px-3 py-2 mb-3">
          <p className="text-[10px] text-[#F85149] font-bold">No strategic changes remaining — team allocation is locked</p>
        </div>
      )}

      {allOps.length === 0 ? (
        /* Empty state */
        <div className="py-3">
          <div className="text-center mb-3">
            <div className="text-3xl mb-2">🏭</div>
            <p className="text-sm text-[#8B949E] mb-1">No operators connected</p>
            <p className="text-[10px] text-[#30363D]">Operators join from other browser tabs, or add bots below</p>
          </div>
          <button onClick={() => {
            ['Bot-WH','Bot-ASM','Bot-OVN','Bot-QA','Bot-LOG'].forEach((name, i) => {
              dispatch({ type: 'ADD_OPERATOR', id: genId(), name, stage: ['warehouse','assembly','oven','qa','logistics'][i], isBot: true });
            });
          }} className="w-full py-2.5 text-xs font-bold bg-cyan/15 text-cyan border border-cyan/30 rounded-lg hover:bg-cyan/25 transition-all active:scale-[0.98]">
            Solo Mode — Add Bot Operators
          </button>
          <p className="text-[8px] text-[#30363D] text-center mt-1.5">Bots auto-process each stage at fixed intervals</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Unassigned operators — big prominent cards with stage buttons */}
          {unassigned.map(([id, op]) => (
            <div key={id} className="bg-[#F0B429]/5 border border-[#F0B429]/30 rounded-lg p-3 animate-slide-in">
              <div className="flex items-center gap-2 mb-2.5">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${op.isBot ? 'bg-cyan' : 'bg-[#3FB950]'}`} style={{ animation: 'pulse-glow 2s ease-in-out infinite' }} />
                <span className="text-sm font-bold text-white">{op.name}</span>
                <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold ${op.isBot ? 'bg-cyan/15 text-cyan' : 'bg-[#3FB950]/15 text-[#3FB950]'}`}>
                  {op.isBot ? 'BOT' : 'HUMAN'}
                </span>
                <span className="text-[10px] text-[#F0B429] ml-auto font-medium">Assign to →</span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {STAGES.map(s => {
                  const count = state.stageAssignments[s.id].length;
                  const full = count >= s.maxOps;
                  return (
                    <button key={s.id} onClick={() => move(id, s.id)} disabled={full}
                      className={`py-2 px-1 rounded-lg text-center transition-all ${full
                        ? 'bg-[#21262D] text-[#30363D] cursor-not-allowed'
                        : 'bg-[#0D1117] text-[#8B949E] border border-[#30363D] hover:border-[#F0B429] hover:text-[#F0B429] hover:bg-[#F0B429]/5 active:scale-95'
                      }`}>
                      <div className="text-base leading-none mb-0.5">{s.icon}</div>
                      <div className="text-[8px] font-bold">{s.shortName}</div>
                      <div className="text-[7px] opacity-40">{count}/{s.maxOps}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Assigned operators — compact rows with reassign dropdown */}
          {assigned.length > 0 && (
            <div className={`${unassigned.length > 0 ? 'pt-1 border-t border-[#21262D]' : ''}`}>
              {assigned.map(([id, op]) => {
                const cs = getStage(id);
                return (
                  <div key={id} className="flex items-center gap-2 text-xs py-1.5 px-2 rounded hover:bg-[#0D1117]/50 transition-colors">
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${op.isBot ? 'bg-cyan' : 'bg-[#3FB950]'}`} />
                    <span className="text-[#8B949E] w-20 truncate">{op.name}</span>
                    <span className="text-[10px] text-[#21262D]">→</span>
                    <select value={cs || ''} onChange={e => move(id, e.target.value || null)}
                      disabled={noChanges}
                      className={`bg-[#0D1117] border border-[#30363D] rounded px-2 py-0.5 text-[10px] text-white flex-1 min-w-0 focus:border-[#F0B429] focus:outline-none transition-colors ${noChanges ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <option value="">Unassign</option>
                      {STAGES.map(s => <option key={s.id} value={s.id} disabled={state.stageAssignments[s.id].length >= s.maxOps && s.id !== cs}>{s.icon} {s.name} ({state.stageAssignments[s.id].length}/{s.maxOps})</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          {/* Fill empty stages with bots */}
          {emptyStages.length > 0 && botOps.length === 0 && (
            <button onClick={() => {
              emptyStages.forEach(s => {
                dispatch({ type: 'ADD_OPERATOR', id: genId(), name: `Bot-${s.shortName}`, stage: s.id, isBot: true });
              });
            }} className="w-full py-1.5 text-[10px] font-medium text-cyan/60 border border-dashed border-[#21262D] rounded-lg hover:border-cyan/30 hover:text-cyan transition-colors">
              + Fill {emptyStages.length} empty stage{emptyStages.length !== 1 ? 's' : ''} with bots
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── STRATEGY BRIEFING (used in staging phase) ─────────────────────────────
function StrategyBriefing() {
  return (
    <div className="space-y-3">
      {/* Pipeline Flow */}
      <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-4">
        <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wider">Production Pipeline</h3>
        <div className="flex items-center gap-1 text-[10px] overflow-x-auto pb-1">
          {STAGES.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1 shrink-0">
              {i > 0 && <span className="text-[#30363D]">→</span>}
              <div className="bg-[#0D1117] border border-[#21262D] rounded-lg px-2.5 py-1.5 text-center">
                <div className="text-sm leading-none mb-0.5">{s.icon}</div>
                <div className="text-[9px] font-bold text-white">{s.shortName}</div>
                <div className="text-[8px] text-[#8B949E]">max {s.maxOps}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Chip Values & Times */}
      <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-4">
        <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wider">Chip Types</h3>
        <div className="space-y-2">
          {Object.values(CHIP_TYPES).map(chip => (
            <div key={chip.name} className="flex items-center gap-3 bg-[#0D1117] border border-[#21262D] rounded-lg px-3 py-2">
              <div className="shrink-0">
                <ChipIcon chipType={chip.name} size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white">{chip.name}</span>
                  <span className="text-[9px] text-[#8B949E]">{chip.label}</span>
                </div>
                <div className="flex gap-3 mt-0.5 text-[9px] text-[#8B949E]">
                  <span>{chip.pieces} pcs</span>
                  <span>Build {chip.assemblyTime}s</span>
                  <span>Oven {chip.ovenTime}s</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className="text-xs font-bold text-[#3FB950]">${chip.value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Key Constraints */}
      <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-4">
        <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wider">Key Constraints</h3>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2">
            <div className="text-[#F0B429] font-bold mb-0.5">🔥 Oven</div>
            <div className="text-[#8B949E]">8 chips per batch</div>
            <div className="text-[#8B949E]">2nd oven: $2,000 @ 3min</div>
          </div>
          <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2">
            <div className="text-[#F0B429] font-bold mb-0.5">⏰ Orders</div>
            <div className="text-[#8B949E]">Standard: 3min expiry</div>
            <div className="text-[#8B949E]">Express: 90s (1.5x pay)</div>
          </div>
          <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2">
            <div className="text-[#F0B429] font-bold mb-0.5">⚠️ Penalties</div>
            <div className="text-[#8B949E]">$50 per expired order</div>
          </div>
          <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2">
            <div className="text-[#F0B429] font-bold mb-0.5">🔧 Changes</div>
            <div className="text-[#8B949E]">3 strategic changes max</div>
            <div className="text-[#8B949E]">during simulation</div>
          </div>
        </div>
      </div>

      {/* Strategy Tips */}
      <div className="bg-[#F0B429]/5 border border-[#F0B429]/20 rounded-xl p-4">
        <h3 className="text-xs font-bold text-[#F0B429] mb-2 uppercase tracking-wider">Strategy Tips</h3>
        <ul className="space-y-1.5 text-[10px] text-[#C9D1D9]">
          <li className="flex gap-2"><span className="text-[#F0B429] shrink-0">1.</span>Assembly is the bottleneck — max 3 operators, longest build times</li>
          <li className="flex gap-2"><span className="text-[#F0B429] shrink-0">2.</span>Full oven batches (8 chips) = best efficiency, don't fire half-empty</li>
          <li className="flex gap-2"><span className="text-[#F0B429] shrink-0">3.</span>EXPRESS orders pay 1.5x but expire in 90s — prioritize or ignore?</li>
          <li className="flex gap-2"><span className="text-[#F0B429] shrink-0">4.</span>QA needs only 1 operator but processes 5s per chip — can bottleneck late</li>
          <li className="flex gap-2"><span className="text-[#F0B429] shrink-0">5.</span>Plan your 3 changes wisely — save one for emergencies</li>
        </ul>
      </div>
    </div>
  );
}

// ─── BOTTLENECK BAR ──────────────────────────────────────────────────────────
function BottleneckBar({ state }) {
  const qs = { warehouse: state.orders.filter(o => o.status === 'pending').length, assembly: state.warehouseQueue.length, oven: state.ovenQueue.length, qa: state.qaQueue.length + state.qaInProgress.length, logistics: state.finishedChips.length };
  const mx = Math.max(...Object.values(qs));
  return (
    <div className="flex gap-1 items-end h-8">
      {STAGES.map(s => { const q = qs[s.id]; const h = mx > 0 ? Math.max(4, (q/Math.max(mx,1))*32) : 4; const c = q > 6 ? '#F85149' : q > 3 ? '#F0B429' : '#3FB950'; return <div key={s.id} className="flex flex-col items-center gap-0.5 flex-1"><div className="rounded-sm w-full transition-all" style={{ height: `${h}px`, backgroundColor: c }} /><span className="text-[8px] text-[#8B949E] font-mono">{s.shortName}</span></div>; })}
    </div>
  );
}

// ─── METRICS PANEL ───────────────────────────────────────────────────────────
function MetricsPanel({ state }) {
  const el = state.elapsedTime || 1;
  const shipped = state.shippedChips.length;
  const tp = el > 0 ? (shipped / (el / 60)).toFixed(1) : '0.0';
  const oRT = state.ovenBatches.reduce((s, b) => s + b.weldTime, 0);
  const oU = el > 0 ? ((oRT / el) * 100).toFixed(0) : 0;
  const aBS = state.ovenBatches.length > 0 ? (state.ovenBatches.reduce((s, b) => s + b.size, 0) / state.ovenBatches.length).toFixed(1) : '0';
  const oE = state.ovenBatches.length > 0 ? ((aBS / OVEN_CAPACITY) * 100).toFixed(0) : 0;
  const tO = state.orders.length;
  const fO = state.orders.filter(o => o.status === 'shipped').length;
  const fR = tO > 0 ? ((fO / tO) * 100).toFixed(0) : 0;
  const aLT = state.orderLeadTimes.length > 0 ? (state.orderLeadTimes.reduce((s, t) => s + t, 0) / state.orderLeadTimes.length).toFixed(0) : '-';
  const wip = state.warehouseQueue.length + state.assemblyInProgress.length + state.ovenQueue.length + state.ovens.reduce((s, o) => s + o.batch.length, 0) + state.qaQueue.length + state.qaInProgress.length + state.finishedChips.length;
  return (
    <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
      <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2">KPIs</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {[['Throughput',`${tp}/min`],['Oven Util.',`${oU}%`],['Oven Eff.',`${oE}%`],['Fulfill Rate',`${fR}%`],['Avg Lead',aLT !== '-' ? formatTime(aLT) : '-'],['WIP',wip],['Shipped',shipped,'#3FB950'],['Expired',state.orders.filter(o=>o.status==='expired').length,'#F85149']].map(([l,v,c],i) => <div key={i} className="flex justify-between"><span className="text-[#8B949E]">{l}</span><span className="font-mono" style={{color:c||'white'}}>{v}</span></div>)}
      </div>
    </div>
  );
}

// ─── INTERACTIVE: WAREHOUSE ──────────────────────────────────────────────────
function InteractiveWarehouse({ state, dispatch }) {
  const [activeOrder, setActiveOrder] = useState(null);
  const [collected, setCollected] = useState({});
  const pendingOrders = state.orders.filter(o => o.status === 'pending' && o.expiresAt > state.elapsedTime);

  const startKitting = (order) => {
    setActiveOrder(order);
    setCollected({});
  };

  const pickBrick = (color) => {
    if (!activeOrder) return;
    const chip = CHIP_TYPES[activeOrder.chipType];
    const needed = (chip.piecesNeeded[color] || 0) * activeOrder.quantity;
    const have = collected[color] || 0;
    if (have >= needed) return;
    if (state.stock[color] <= 0) return;

    const newCollected = { ...collected, [color]: have + 1 };
    setCollected(newCollected);

    // Check if kit is complete
    let complete = true;
    for (const [c, n] of Object.entries(chip.piecesNeeded)) {
      if ((newCollected[c] || 0) < n * activeOrder.quantity) { complete = false; break; }
    }
    if (complete) {
      dispatch({ type: 'KIT_CHIPS', chipType: activeOrder.chipType, quantity: activeOrder.quantity, orderId: activeOrder.id });
      setActiveOrder(null);
      setCollected({});
    }
  };

  const totalNeeded = activeOrder ? Object.entries(CHIP_TYPES[activeOrder.chipType].piecesNeeded).reduce((s, [, n]) => s + n * activeOrder.quantity, 0) : 0;
  const totalCollected = Object.values(collected).reduce((s, n) => s + n, 0);

  return (
    <div className="space-y-4">
      {!activeOrder ? (
        <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
          <h3 className="text-sm font-bold text-[#F0B429] mb-3">Select an order to kit</h3>
          {pendingOrders.length === 0 && <p className="text-xs text-[#8B949E]">No pending orders — waiting for new orders...</p>}
          <div className="space-y-2">
            {pendingOrders.map(order => {
              const chip = CHIP_TYPES[order.chipType];
              const canDo = canKitOrder(order, state.stock);
              return (
                <button key={order.id} onClick={() => canDo && startKitting(order)} disabled={!canDo}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${canDo ? 'border-[#30363D] bg-[#0D1117] hover:border-[#F0B429] cursor-pointer' : 'border-[#21262D] bg-[#0D1117] opacity-40 cursor-not-allowed'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ChipIcon chipType={order.chipType} size={18} />
                      <span className="text-xs font-bold text-white">#{order.orderNumber} {order.chipType} × {order.quantity}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: URGENCY_TYPES[order.urgency].color + '22', color: URGENCY_TYPES[order.urgency].color }}>{order.urgency}</span>
                    </div>
                    <span className="text-xs font-mono text-[#8B949E]">⏱ {formatTime(Math.max(0, order.expiresAt - state.elapsedTime))}</span>
                  </div>
                  <div className="flex gap-2 mt-2">{Object.entries(chip.piecesNeeded).map(([c, n]) => <span key={c} className="text-[10px] text-[#8B949E]"><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ backgroundColor: BRICK_COLORS[c] }} />{c} ×{n * order.quantity}</span>)}</div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="bg-[#161B22] border border-[#F0B429]/40 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ChipIcon chipType={activeOrder.chipType} size={18} />
                <span className="text-sm font-bold text-white">Kitting #{activeOrder.orderNumber}: {activeOrder.chipType} × {activeOrder.quantity}</span>
              </div>
              <button onClick={() => { setActiveOrder(null); setCollected({}); }} className="text-[10px] text-[#8B949E] hover:text-white">Cancel</button>
            </div>
            <ProgressBar value={totalCollected} max={totalNeeded} color="#F0B429" height="h-3" />
            <p className="text-[10px] text-[#8B949E] mt-1 font-mono text-center">{totalCollected} / {totalNeeded} bricks picked</p>
          </div>

          {/* Brick Bins */}
          <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
            <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-3">Tap bricks to pick</h3>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(CHIP_TYPES[activeOrder.chipType].piecesNeeded).map(([color, perChip]) => {
                const needed = perChip * activeOrder.quantity;
                const have = collected[color] || 0;
                const done = have >= needed;
                const stockLeft = state.stock[color];
                return (
                  <button key={color} onClick={() => pickBrick(color)} disabled={done || stockLeft <= 0}
                    className={`relative p-3 rounded-lg border-2 transition-all text-center ${done ? 'border-[#3FB950] bg-[#3FB950]/10' : 'border-[#30363D] bg-[#0D1117] hover:border-[#F0B429] active:scale-95'} ${stockLeft <= 0 ? 'opacity-30' : ''}`}>
                    <div className="w-10 h-10 rounded-md mx-auto mb-2 flex items-center justify-center" style={{ backgroundColor: BRICK_COLORS[color] }}>
                      <div className="w-5 h-5 rounded-full border-2 border-white/30" />
                    </div>
                    <div className="text-[10px] font-bold text-white">{color}</div>
                    <div className="text-[10px] font-mono text-[#8B949E]">{have}/{needed}</div>
                    <div className="text-[8px] text-[#30363D]">stock: {stockLeft}</div>
                    {done && <div className="absolute inset-0 flex items-center justify-center"><span className="text-2xl">✓</span></div>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Kit tray visualization */}
          <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
            <h3 className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider mb-2">Kit Tray</h3>
            <div className="flex gap-1 flex-wrap">
              {Object.entries(collected).flatMap(([color, count]) => Array.from({ length: count }, (_, i) => (
                <div key={`${color}-${i}`} className="w-5 h-5 rounded-sm animate-slide-in" style={{ backgroundColor: BRICK_COLORS[color] }}>
                  <div className="w-2.5 h-2.5 rounded-full border border-white/20 mx-auto mt-[3px]" />
                </div>
              )))}
              {totalCollected === 0 && <span className="text-[10px] text-[#30363D]">Pick bricks from bins above...</span>}
            </div>
          </div>
        </div>
      )}

      {/* Stock overview */}
      <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
        <h3 className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider mb-2">Stock</h3>
        <div className="grid grid-cols-4 gap-1.5">
          {Object.entries(state.stock).map(([color, amount]) => (
            <div key={color} className="flex items-center gap-1 text-[10px]">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: BRICK_COLORS[color] }} />
              <span className={`font-mono ${amount < 20 ? 'text-[#F85149]' : 'text-[#8B949E]'}`}>{amount}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── INTERACTIVE: CHIP BUILDER ───────────────────────────────────────────────
function ChipBuilder({ chipType, onComplete }) {
  const pattern = BUILD_PATTERNS[chipType];
  const [placed, setPlaced] = useState(() => Array(pattern.rows).fill(null).map(() => Array(pattern.cols).fill(null)));
  const [lastPlaced, setLastPlaced] = useState(null);
  const [selectedColor, setSelectedColor] = useState(null);

  const totalPieces = pattern.rows * pattern.cols;
  const placedCount = placed.flat().filter(Boolean).length;
  const isComplete = placedCount === totalPieces;

  // Count remaining per color
  const remaining = {};
  pattern.grid.forEach((row, r) => row.forEach((color, c) => {
    if (!placed[r][c]) remaining[color] = (remaining[color] || 0) + 1;
  }));

  useEffect(() => {
    if (isComplete) { const t = setTimeout(() => onComplete(), 600); return () => clearTimeout(t); }
  }, [isComplete, onComplete]);

  const handleCellClick = (r, c) => {
    if (placed[r][c]) return;
    const target = pattern.grid[r][c];
    if (selectedColor && selectedColor !== target) return; // wrong color
    const np = placed.map(row => [...row]);
    np[r][c] = target;
    setPlaced(np);
    setLastPlaced(`${r}-${c}`);
    setTimeout(() => setLastPlaced(null), 300);
    // Auto-deselect if no more of this color needed
    const newRemaining = (remaining[target] || 1) - 1;
    if (newRemaining <= 0) setSelectedColor(null);
  };

  return (
    <div className="space-y-4">
      {/* Blueprint header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChipIcon chipType={chipType} size={20} />
          <span className="text-sm font-bold text-white">CHIP {chipType}</span>
        </div>
        <span className="text-xs font-mono text-[#F0B429]">{placedCount}/{totalPieces} placed</span>
      </div>

      <ProgressBar value={placedCount} max={totalPieces} color="#22D3EE" height="h-2" />

      {/* Parts tray — select a color first */}
      <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-3">
        <p className="text-[10px] text-[#8B949E] mb-2 uppercase tracking-wider font-bold">Parts Tray — tap a color, then tap a cell</p>
        <div className="flex gap-2 justify-center">
          {Object.entries(remaining).map(([color, count]) => (
            <button key={color} onClick={() => setSelectedColor(color === selectedColor ? null : color)}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-lg border-2 transition-all active:scale-95 ${selectedColor === color ? 'border-white bg-white/10 scale-105' : 'border-[#30363D] hover:border-[#8B949E]'}`}>
              <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ backgroundColor: BRICK_COLORS[color] }}>
                <div className="w-4 h-4 rounded-full border-2 border-white/30" />
              </div>
              <span className="text-[9px] font-mono text-[#8B949E]">×{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Build grid */}
      <div className="flex justify-center">
        <div className="inline-grid gap-1.5 p-4 bg-[#0D1117] border border-[#21262D] rounded-xl" style={{ gridTemplateColumns: `repeat(${pattern.cols}, 1fr)` }}>
          {pattern.grid.map((row, r) => row.map((targetColor, c) => {
            const isPlaced = !!placed[r][c];
            const isJustPlaced = lastPlaced === `${r}-${c}`;
            const isValidTarget = selectedColor === targetColor || !selectedColor;
            return (
              <button key={`${r}-${c}`} onClick={() => handleCellClick(r, c)} disabled={isPlaced}
                className={`w-14 h-14 rounded-lg border-2 transition-all flex flex-col items-center justify-center ${isPlaced ? 'border-transparent' : isValidTarget && selectedColor ? 'border-dashed border-white/40 cursor-pointer hover:scale-105 active:scale-95' : selectedColor ? 'border-[#21262D] opacity-30' : 'border-dashed border-[#30363D] cursor-pointer hover:border-[#8B949E] active:scale-95'}`}
                style={isPlaced ? { backgroundColor: BRICK_COLORS[placed[r][c]], transform: isJustPlaced ? 'scale(1.15)' : 'scale(1)' } : {}}>
                {isPlaced ? (
                  <div className="w-6 h-6 rounded-full border-2 border-white/30" />
                ) : (
                  <>
                    <div className="w-6 h-6 rounded-full border-2 border-dashed opacity-20" style={{ borderColor: BRICK_COLORS[targetColor] }} />
                    <span className="text-[7px] mt-0.5 opacity-30" style={{ color: BRICK_COLORS[targetColor] }}>{targetColor}</span>
                  </>
                )}
              </button>
            );
          }))}
        </div>
      </div>

      {isComplete && (
        <div className="text-center animate-slide-in">
          <div className="text-3xl mb-1">✓</div>
          <p className="text-sm font-bold text-[#3FB950]">Chip assembled!</p>
        </div>
      )}
    </div>
  );
}

// ─── INTERACTIVE: ASSEMBLY ───────────────────────────────────────────────────
function InteractiveAssembly({ state, dispatch }) {
  const [building, setBuilding] = useState(null); // { id, chipType, orderId }

  const startBuilding = () => {
    if (state.warehouseQueue.length === 0) return;
    const chip = state.warehouseQueue[0];
    dispatch({ type: 'CLAIM_FOR_ASSEMBLY', chipId: chip.id });
    setBuilding(chip);
  };

  const handleComplete = useCallback(() => {
    if (!building) return;
    dispatch({ type: 'COMPLETE_HUMAN_ASSEMBLY', chipId: building.id, chipType: building.chipType, orderId: building.orderId });
    setBuilding(null);
  }, [building, dispatch]);

  return (
    <div className="space-y-4">
      {!building ? (
        <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
          <h3 className="text-sm font-bold text-[#F0B429] mb-3">Assembly Workbench</h3>
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[#8B949E]">Kitted chips waiting:</span>
            <span className="font-mono font-bold text-white">{state.warehouseQueue.length}</span>
          </div>
          {state.warehouseQueue.length > 0 ? (
            <>
              <div className="flex gap-1.5 mb-3 flex-wrap">
                {state.warehouseQueue.slice(0, 8).map(chip => (
                  <div key={chip.id} className="p-1.5 bg-[#0D1117] border border-[#21262D] rounded"><ChipIcon chipType={chip.chipType} size={16} /></div>
                ))}
                {state.warehouseQueue.length > 8 && <span className="text-[10px] text-[#8B949E] self-center">+{state.warehouseQueue.length - 8} more</span>}
              </div>
              <button onClick={startBuilding} className="w-full py-3 text-sm font-bold bg-cyan/20 text-cyan border border-cyan/30 rounded-lg hover:bg-cyan/30 transition-colors active:scale-[0.98]">
                Build Next Chip ({state.warehouseQueue[0]?.chipType})
              </button>
            </>
          ) : (
            <p className="text-xs text-[#8B949E] text-center py-4">Waiting for kitted chips from Warehouse...</p>
          )}

          {/* Show bot assembly progress */}
          {state.assemblyInProgress.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[#21262D]">
              <p className="text-[10px] text-[#8B949E] mb-1.5 uppercase tracking-wider font-bold">Bot Assembly In Progress</p>
              {state.assemblyInProgress.map(a => {
                const progress = Math.min((state.elapsedTime - a.startedAt) / (a.completesAt - a.startedAt), 1);
                return (
                  <div key={a.chipId} className="mb-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <div className="flex items-center gap-1"><ChipIcon chipType={a.chipType} size={12} /><span className="text-[#8B949E]">{a.chipType}</span></div>
                      <span className="font-mono text-[#F0B429]">{formatTime(Math.max(0, a.completesAt - state.elapsedTime))}</span>
                    </div>
                    <ProgressBar value={progress * 100} max={100} color="#22D3EE" height="h-1" />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-[#161B22] border border-cyan/30 rounded-lg p-4">
          <ChipBuilder chipType={building.chipType} onComplete={handleComplete} />
        </div>
      )}
    </div>
  );
}

// ─── INTERACTIVE: OVEN ───────────────────────────────────────────────────────
function InteractiveOven({ state, dispatch }) {
  return (
    <div className="space-y-3">
      <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
        <h3 className="text-sm font-bold text-[#F0B429] mb-3">Oven Control Panel</h3>
        <div className="flex items-center justify-between text-xs mb-3">
          <span className="text-[#8B949E]">Chips waiting for oven:</span>
          <span className="font-mono font-bold text-white">{state.ovenQueue.length}</span>
        </div>
        {state.ovenQueue.length > 0 && (
          <div className="flex gap-1 mb-3 flex-wrap">
            {state.ovenQueue.slice(0, 12).map(chip => <div key={chip.id} className="p-1 bg-[#0D1117] border border-[#21262D] rounded"><ChipIcon chipType={chip.chipType} size={14} /></div>)}
          </div>
        )}
        <div className="space-y-3">
          {state.ovens.map(oven => (
            <OvenDisplay key={oven.id} oven={oven} elapsed={state.elapsedTime}
              onLoadAll={state.ovenQueue.length > 0 ? (id) => dispatch({ type: 'LOAD_OVEN_ALL', ovenId: id }) : null} />
          ))}
        </div>
      </div>
      {!state.hasSecondOven && state.elapsedTime >= 180 && (
        state.strategicChangesUsed >= state.maxStrategicChanges
          ? <p className="text-[10px] text-[#F85149] text-center">No strategic changes remaining</p>
          : <button onClick={() => dispatch({ type: 'BUY_SECOND_OVEN' })} className="w-full py-2 text-xs font-bold bg-[#F85149]/20 text-[#F85149] border border-[#F85149]/40 rounded hover:bg-[#F85149]/30 transition-colors cursor-pointer">Buy 2nd Oven (-$2,000) — uses 1 change</button>
      )}
      {!state.hasSecondOven && state.elapsedTime < 180 && <p className="text-[10px] text-[#8B949E] text-center">2nd oven available after Round 3</p>}
    </div>
  );
}

// ─── INTERACTIVE: QA ─────────────────────────────────────────────────────────
function InteractiveQA({ state }) {
  return (
    <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
      <h3 className="text-sm font-bold text-[#F0B429] mb-3">QA Inspection Station</h3>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-[#8B949E]">Waiting:</span><span className="font-mono font-bold text-white">{state.qaQueue.length}</span>
      </div>
      <div className="flex items-center justify-between text-xs mb-3">
        <span className="text-[#8B949E]">Inspecting:</span><span className="font-mono font-bold text-cyan">{state.qaInProgress.length}</span>
      </div>
      <p className="text-[10px] text-[#3FB950] mb-2">Auto-inspecting ({QA_TIME}s per chip)</p>
      {state.qaInProgress.length > 0 && (
        <div className="space-y-2">
          {state.qaInProgress.map(q => {
            const progress = Math.min((state.elapsedTime - q.startedAt) / QA_TIME, 1);
            return (
              <div key={q.chipId}>
                <div className="flex items-center justify-between text-[10px] mb-0.5">
                  <div className="flex items-center gap-1"><ChipIcon chipType={q.chipType} size={14} /><span className="text-[#8B949E]">{q.chipType}</span></div>
                  <span className="font-mono text-[#F0B429]">{formatTime(Math.max(0, q.completesAt - state.elapsedTime))}</span>
                </div>
                <ProgressBar value={progress * 100} max={100} color="#3FB950" height="h-1.5" />
              </div>
            );
          })}
        </div>
      )}
      {state.qaQueue.length === 0 && state.qaInProgress.length === 0 && <p className="text-xs text-[#8B949E] text-center py-4">Waiting for chips from oven...</p>}
    </div>
  );
}

// ─── INTERACTIVE: LOGISTICS ──────────────────────────────────────────────────
function InteractiveLogistics({ state, dispatch }) {
  const shippable = state.orders.filter(o => {
    if (o.status === 'shipped' || o.status === 'expired') return false;
    return state.finishedChips.filter(c => c.orderId === o.id).length >= o.quantity;
  });

  return (
    <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
      <h3 className="text-sm font-bold text-[#F0B429] mb-3">Shipping Dock</h3>
      <div className="flex items-center justify-between text-xs mb-3">
        <span className="text-[#8B949E]">Finished chips in stock:</span>
        <span className="font-mono font-bold text-white">{state.finishedChips.length}</span>
      </div>

      {shippable.length > 0 ? (
        <div className="space-y-2">
          {shippable.map(order => (
            <div key={order.id} className="bg-[#0D1117] border border-[#3FB950]/30 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <ChipIcon chipType={order.chipType} size={16} />
                  <span className="text-xs font-bold text-white">#{order.orderNumber} {order.chipType} × {order.quantity}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: URGENCY_TYPES[order.urgency].color + '22', color: URGENCY_TYPES[order.urgency].color }}>{order.urgency}</span>
                </div>
                <span className="text-xs font-mono text-[#F0B429]">${order.value.toLocaleString()}</span>
              </div>
              <button onClick={() => dispatch({ type: 'SHIP_ORDER', orderId: order.id })}
                className="w-full py-2 text-sm font-bold bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/40 rounded-lg hover:bg-[#3FB950]/30 transition-colors active:scale-[0.98]">
                Ship Order #{order.orderNumber}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[#8B949E] text-center py-4">No orders ready to ship. Waiting for chips to pass QA...</p>
      )}

      {/* Show finished chips by order */}
      {state.finishedChips.length > 0 && shippable.length === 0 && (
        <div className="mt-3 pt-3 border-t border-[#21262D]">
          <p className="text-[10px] text-[#8B949E] mb-1.5">Chips in stock (waiting for full order):</p>
          <div className="flex gap-1 flex-wrap">{state.finishedChips.slice(0, 16).map(c => <div key={c.id} className="p-1 bg-[#0D1117] border border-[#21262D] rounded"><ChipIcon chipType={c.chipType} size={12} /></div>)}</div>
        </div>
      )}
    </div>
  );
}

// ─── DIRECTOR VIEW (read-only — no stage action buttons) ─────────────────────
function DirectorView({ state, dispatch, roomCode }) {
  const [copied, setCopied] = useState(false);
  const netScore = state.revenue - state.penalties - (state.hasSecondOven ? SECOND_OVEN_COST : 0);
  const elapsed = state.elapsedTime || 0;
  const remaining = SIM_DURATION - elapsed;
  const throughput = elapsed > 0 ? (state.shippedChips.length / (elapsed / 60)).toFixed(1) : '0.0';
  const totalOps = Object.keys(state.operators).length;
  const humanOps = Object.values(state.operators).filter(op => !op.isBot).length;
  const unassignedOps = Object.keys(state.operators).filter(id => !Object.values(state.stageAssignments).some(ops => ops.includes(id)));
  const emptyStages = STAGES.filter(s => state.stageAssignments[s.id].length === 0);
  const inviteURL = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  const copyInvite = () => { navigator.clipboard.writeText(inviteURL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };

  return (
    <div className="min-h-screen bg-[#0D1117] text-white">
      {/* Top Bar */}
      <div className="bg-[#161B22] border-b border-[#30363D] px-4 py-2">
        <div className="flex items-center justify-between max-w-[1400px] mx-auto">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-black tracking-wider text-[#F0B429]">LEGO CHIP FACTORY</h1>
            <span className="text-xs px-1.5 py-0.5 bg-[#F0B429]/20 text-[#F0B429] rounded font-bold">DIRECTOR</span>
            {/* Room code badge */}
            <button onClick={copyInvite} title="Click to copy invite link"
              className="flex items-center gap-1.5 bg-[#0D1117] border border-[#F0B429]/30 rounded-lg px-2.5 py-1 hover:border-[#F0B429] transition-colors group">
              <span className="text-[9px] text-[#8B949E] uppercase font-bold">Room</span>
              <span className="text-sm font-mono font-black text-[#F0B429] tracking-wider">{roomCode}</span>
              <span className="text-[10px] text-[#30363D] group-hover:text-[#8B949E] transition-colors">{copied ? '✓' : '📋'}</span>
            </button>
            <span className="text-xs font-mono text-[#8B949E] bg-[#0D1117] px-2 py-0.5 rounded">ROUND {state.round}/10</span>
            <span className={`text-sm font-mono font-bold ${remaining < 60 ? 'text-[#F85149]' : 'text-white'}`}>{formatTime(remaining)}</span>
          </div>
          <div className="flex items-center gap-6">
            {/* Live operator count */}
            <div className="flex items-center gap-1.5 bg-[#0D1117] px-2.5 py-1 rounded-lg border border-[#21262D]">
              <div className={`w-2 h-2 rounded-full ${totalOps > 0 ? 'bg-[#3FB950]' : 'bg-[#30363D]'}`} style={totalOps > 0 ? { animation: 'pulse-glow 2s ease-in-out infinite' } : {}} />
              <span className="text-[10px] font-mono text-[#8B949E]">{totalOps} ops</span>
              {humanOps > 0 && <span className="text-[10px] text-[#3FB950]">({humanOps} human)</span>}
            </div>
            {/* Strategic changes remaining */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
              state.strategicChangesUsed >= state.maxStrategicChanges
                ? 'bg-[#F85149]/10 border-[#F85149]/30'
                : 'bg-[#0D1117] border-[#21262D]'
            }`}>
              <span className="text-[10px] font-mono text-[#8B949E]">Changes</span>
              <span className={`text-[10px] font-bold font-mono ${
                state.strategicChangesUsed >= state.maxStrategicChanges ? 'text-[#F85149]' : 'text-[#F0B429]'
              }`}>{state.maxStrategicChanges - state.strategicChangesUsed}/{state.maxStrategicChanges}</span>
            </div>
            <div className="text-right"><div className="text-[10px] text-[#8B949E] uppercase">Net Score</div><div className={`text-lg font-mono font-bold ${netScore >= 0 ? 'text-[#3FB950]' : 'text-[#F85149]'}`}>${netScore.toLocaleString()}</div></div>
            <div className="text-right"><div className="text-[10px] text-[#8B949E] uppercase">Throughput</div><div className="text-lg font-mono font-bold text-cyan">{throughput}/min</div></div>
            <div className="text-right"><div className="text-[10px] text-[#8B949E] uppercase">Revenue</div><div className="text-sm font-mono text-[#3FB950]">+${state.revenue.toLocaleString()}</div></div>
            <div className="text-right"><div className="text-[10px] text-[#8B949E] uppercase">Penalties</div><div className="text-sm font-mono text-[#F85149]">-${(state.penalties + (state.hasSecondOven ? SECOND_OVEN_COST : 0)).toLocaleString()}</div></div>
          </div>
        </div>
      </div>

      {/* Paused Banner */}
      {state.phase === 'paused' && (
        <div className="bg-[#F0B429]/10 border-b border-[#F0B429]/30 px-4 py-2 text-center">
          <span className="text-sm font-bold text-[#F0B429]">SIMULATION PAUSED</span>
          <span className="text-xs text-[#8B949E] ml-2">— Teacher has paused this session</span>
        </div>
      )}

      {/* Alerts & Operator Warnings */}
      <div className="max-w-[1400px] mx-auto px-4 mt-2 space-y-1.5">
        <AlertBanner alerts={state.alerts} />
        {totalOps === 0 && (
          <div className="border-2 border-[#F0B429] bg-[#F0B429]/10 rounded-lg px-4 py-3 flex items-center gap-3 animate-slide-in">
            <span className="text-2xl">👥</span>
            <div className="flex-1">
              <p className="text-sm font-bold text-[#F0B429]">No operators connected</p>
              <p className="text-[10px] text-[#8B949E]">Share room code <span className="font-mono font-bold text-[#F0B429]">{roomCode}</span> with your team, or add Bot Operators in the Team Roster</p>
            </div>
            <button onClick={copyInvite}
              className="shrink-0 px-3 py-1.5 text-[10px] font-bold bg-[#F0B429]/20 text-[#F0B429] border border-[#F0B429]/40 rounded-lg hover:bg-[#F0B429]/30 transition-colors">
              {copied ? '✓ Copied!' : '📋 Copy Invite Link'}
            </button>
          </div>
        )}
        {totalOps > 0 && unassignedOps.length > 0 && (
          <div className="border-2 border-[#F0B429] bg-[#F0B429]/10 rounded-lg px-4 py-3 flex items-center justify-between animate-slide-in">
            <div className="flex items-center gap-3">
              <span className="text-xl">⚠️</span>
              <div>
                <p className="text-sm font-bold text-[#F0B429]">{unassignedOps.length} operator{unassignedOps.length > 1 ? 's' : ''} waiting for assignment</p>
                <p className="text-[10px] text-[#8B949E]">
                  {unassignedOps.map(id => state.operators[id]?.name).filter(Boolean).join(', ')} — assign in Team Roster →
                </p>
              </div>
            </div>
            <div className="flex gap-1">
              {unassignedOps.slice(0, 3).map(id => (
                <div key={id} className="w-8 h-8 rounded-full bg-[#F0B429]/20 border border-[#F0B429]/40 flex items-center justify-center text-[10px] font-bold text-[#F0B429]">
                  {(state.operators[id]?.name || '?')[0].toUpperCase()}
                </div>
              ))}
            </div>
          </div>
        )}
        {totalOps > 0 && unassignedOps.length === 0 && emptyStages.length > 0 && (
          <div className="border border-[#F85149]/40 bg-[#F85149]/5 rounded-lg px-4 py-2 flex items-center gap-2">
            <span className="text-xs text-[#F85149] font-medium">{emptyStages.map(s => s.name).join(', ')} — no operator assigned</span>
          </div>
        )}
      </div>

      {/* Main */}
      <div className="max-w-[1400px] mx-auto px-4 py-3">
        {/* Pipeline */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2"><span className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">Pipeline Status</span><div className="flex-1 h-px bg-[#30363D]" /></div>
          <div className="grid grid-cols-5 gap-2 mb-2">{STAGES.map(s => <StagePanel key={s.id} stage={s} state={state} />)}</div>
          <BottleneckBar state={state} />
        </div>

        <div className="grid grid-cols-12 gap-3">
          {/* Left: Status panels (read-only) */}
          <div className="col-span-8 grid grid-cols-2 gap-3">
            {/* Warehouse Status */}
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-2">📦 Warehouse</h3>
              <div className="grid grid-cols-2 gap-1.5 mb-2">
                {Object.entries(state.stock).map(([color, amount]) => (
                  <div key={color} className="flex items-center justify-between text-[10px]">
                    <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: BRICK_COLORS[color] }} /><span className="text-[#8B949E]">{color}</span></div>
                    <span className={`font-mono font-bold ${amount < 20 ? 'text-[#F85149]' : 'text-white'}`}>{amount}</span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-[#8B949E]">{state.orders.filter(o => o.status === 'pending').length} orders pending kit</div>
            </div>

            {/* Assembly Status */}
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-2">🔧 Assembly</h3>
              <div className="text-xs space-y-1">
                <div className="flex justify-between"><span className="text-[#8B949E]">Kitted waiting:</span><span className="font-mono text-white">{state.warehouseQueue.length}</span></div>
                <div className="flex justify-between"><span className="text-[#8B949E]">Building (bots):</span><span className="font-mono text-cyan">{state.assemblyInProgress.length}</span></div>
                <div className="flex justify-between"><span className="text-[#8B949E]">Assembled → oven:</span><span className="font-mono text-white">{state.ovenQueue.length}</span></div>
              </div>
              {state.assemblyInProgress.length > 0 && state.assemblyInProgress.slice(0, 3).map(a => {
                const p = Math.min((state.elapsedTime - a.startedAt) / (a.completesAt - a.startedAt), 1);
                return <div key={a.chipId} className="mt-1"><ProgressBar value={p*100} max={100} color="#22D3EE" height="h-1" /></div>;
              })}
            </div>

            {/* Oven Status */}
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-2">🔥 Ovens</h3>
              <div className="space-y-2">
                {state.ovens.map(oven => <OvenDisplay key={oven.id} oven={oven} elapsed={state.elapsedTime} />)}
              </div>
              <div className="text-[10px] text-[#8B949E] mt-2">{state.ovenQueue.length} chips waiting</div>
              {!state.hasSecondOven && state.elapsedTime >= 180 && (
                state.strategicChangesUsed >= state.maxStrategicChanges
                  ? <p className="mt-2 text-[10px] text-[#F85149] text-center">No changes left</p>
                  : <button onClick={() => dispatch({ type: 'BUY_SECOND_OVEN' })} className="mt-2 w-full py-1.5 text-[10px] font-bold bg-[#F85149]/20 text-[#F85149] border border-[#F85149]/40 rounded hover:bg-[#F85149]/30 transition-colors cursor-pointer">Buy 2nd Oven — 1 change</button>
              )}
            </div>

            {/* QA + Logistics Status */}
            <div className="space-y-3">
              <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
                <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-2">✅ QA</h3>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-[#8B949E]">Waiting:</span><span className="font-mono text-white">{state.qaQueue.length}</span></div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">Inspecting:</span><span className="font-mono text-cyan">{state.qaInProgress.length}</span></div>
                </div>
              </div>
              <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
                <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-2">🚚 Logistics</h3>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-[#8B949E]">Ready to ship:</span><span className="font-mono text-white">{state.finishedChips.length}</span></div>
                  <div className="flex justify-between"><span className="text-[#8B949E]">Shipped total:</span><span className="font-mono text-[#3FB950]">{state.shippedChips.length}</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Team + Metrics + Orders */}
          <div className="col-span-4 space-y-3">
            <OperatorAssignment state={state} dispatch={dispatch} />
            <MetricsPanel state={state} />
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2">Order Board — {state.orders.filter(o => o.status !== 'shipped' && o.status !== 'expired').length} active</h3>
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {state.orders.filter(o => o.status !== 'shipped' && o.status !== 'expired').sort((a, b) => a.expiresAt - b.expiresAt).map(order => (
                  <OrderCard key={order.id} order={order} elapsed={state.elapsedTime} />
                ))}
              </div>
              <div className="flex gap-3 mt-2 pt-2 border-t border-[#21262D]">
                <span className="text-[10px] text-[#3FB950] font-mono">✓ {state.orders.filter(o => o.status === 'shipped').length} shipped</span>
                <span className="text-[10px] text-[#F85149] font-mono">✗ {state.orders.filter(o => o.status === 'expired').length} expired</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── OPERATOR VIEW ───────────────────────────────────────────────────────────
function OperatorView({ state, dispatch, operatorId, operatorName }) {
  const assignedStage = (() => { for (const [s, ops] of Object.entries(state.stageAssignments)) if (ops.includes(operatorId)) return s; return null; })();
  const stage = STAGES.find(s => s.id === assignedStage);
  const remaining = SIM_DURATION - state.elapsedTime;

  return (
    <div className="min-h-screen bg-[#0D1117] text-white">
      <div className="bg-[#161B22] border-b border-[#30363D] px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-black tracking-wider text-[#F0B429]">LEGO CHIP FACTORY</h1>
            <span className="text-xs text-[#8B949E]">Operator: <span className="text-white font-medium">{operatorName}</span></span>
            {assignedStage && <span className="text-xs px-1.5 py-0.5 bg-[#F0B429]/20 text-[#F0B429] rounded font-bold">{stage.icon} {stage.name}</span>}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs font-mono text-[#8B949E]">ROUND {state.round}/10</span>
            <span className={`text-sm font-mono font-bold ${remaining < 60 ? 'text-[#F85149]' : 'text-white'}`}>{formatTime(remaining)}</span>
          </div>
        </div>
      </div>

      {state.phase === 'paused' && (
        <div className="bg-[#F0B429]/10 border-b border-[#F0B429]/30 px-4 py-2 text-center">
          <span className="text-sm font-bold text-[#F0B429]">SIMULATION PAUSED</span>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-6">
        {!assignedStage ? (
          <div className="py-6 animate-fade-in">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3" style={{ animation: 'pulse-glow 3s ease-in-out infinite' }}>🏭</div>
              <h2 className="text-xl font-bold text-[#F0B429] mb-1">Waiting for Assignment</h2>
              <p className="text-sm text-[#8B949E] mb-1">The Director will assign you to a production stage.</p>
              <p className="text-xs text-[#30363D]">You are connected as <span className="text-[#3FB950]">{operatorName}</span></p>
            </div>

            {/* Connection status */}
            <div className="bg-[#161B22] border border-[#3FB950]/30 rounded-lg p-3 mb-4 flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-[#3FB950]" style={{ animation: 'pulse-glow 2s ease-in-out infinite' }} />
              <div>
                <p className="text-xs font-bold text-[#3FB950]">Connected to factory</p>
                <p className="text-[10px] text-[#8B949E]">Your Director can see you in the Team Roster. Ask them to assign you to a stage.</p>
              </div>
            </div>

            {/* Live factory overview */}
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
              <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-3">Factory Status</h3>
              <div className="space-y-2">
                {STAGES.map(s => {
                  const ops = state.stageAssignments[s.id];
                  const opNames = ops.map(id => state.operators[id]?.name).filter(Boolean);
                  return (
                    <div key={s.id} className={`flex items-center gap-3 text-xs px-3 py-2.5 rounded-lg border transition-colors ${ops.length === 0 ? 'bg-[#F85149]/5 border-[#F85149]/20' : 'bg-[#0D1117] border-[#21262D]'}`}>
                      <span className="text-lg">{s.icon}</span>
                      <div className="flex-1">
                        <span className="text-white font-medium">{s.name}</span>
                        {opNames.length > 0 && <span className="text-[10px] text-[#8B949E] ml-2">({opNames.join(', ')})</span>}
                      </div>
                      <span className={`text-[10px] font-mono ${ops.length === 0 ? 'text-[#F85149]' : 'text-[#8B949E]'}`}>{ops.length}/{s.maxOps}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div>
            {assignedStage === 'warehouse' && <InteractiveWarehouse state={state} dispatch={dispatch} />}
            {assignedStage === 'assembly' && <InteractiveAssembly state={state} dispatch={dispatch} />}
            {assignedStage === 'oven' && <InteractiveOven state={state} dispatch={dispatch} />}
            {assignedStage === 'qa' && <InteractiveQA state={state} />}
            {assignedStage === 'logistics' && <InteractiveLogistics state={state} dispatch={dispatch} />}

            <button onClick={() => dispatch({ type: 'SEND_ALERT', msg: `${operatorName} (${stage.name}): Bottleneck here!`, alertType: 'danger' })}
              className="mt-4 w-full py-2 text-xs font-bold bg-[#F85149]/20 text-[#F85149] border border-[#F85149]/40 rounded hover:bg-[#F85149]/30 transition-colors">
              🚨 Flag Bottleneck to Directors
            </button>
          </div>
        )}

        {/* Mini order board */}
        <div className="mt-6 bg-[#161B22] border border-[#30363D] rounded-lg p-3">
          <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2">Active Orders</h3>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {state.orders.filter(o => o.status !== 'shipped' && o.status !== 'expired').map(order => (
              <div key={order.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                  <ChipIcon chipType={order.chipType} size={12} />
                  <span className="text-white">#{order.orderNumber} {order.chipType}×{order.quantity}</span>
                  <span className="text-[10px] px-1 rounded" style={{ backgroundColor: URGENCY_TYPES[order.urgency].color + '22', color: URGENCY_TYPES[order.urgency].color }}>{order.urgency}</span>
                </div>
                <span className="font-mono text-[#8B949E]">{formatTime(Math.max(0, order.expiresAt - state.elapsedTime))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── OBSERVER VIEW ───────────────────────────────────────────────────────────
function ObserverView({ state }) {
  const netScore = state.revenue - state.penalties - (state.hasSecondOven ? SECOND_OVEN_COST : 0);
  const remaining = SIM_DURATION - state.elapsedTime;
  const throughput = state.elapsedTime > 0 ? (state.shippedChips.length / (state.elapsedTime / 60)).toFixed(1) : '0.0';
  return (
    <div className="min-h-screen bg-[#0D1117] text-white">
      <div className="bg-[#161B22] border-b border-[#30363D] px-4 py-2">
        <div className="flex items-center justify-between max-w-[1400px] mx-auto">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-black tracking-wider text-[#F0B429]">LEGO CHIP FACTORY</h1>
            <span className="text-xs px-1.5 py-0.5 bg-[#8B949E]/20 text-[#8B949E] rounded font-bold">OBSERVER</span>
            <span className="text-xs font-mono text-[#8B949E]">ROUND {state.round}/10</span>
            <span className={`text-sm font-mono font-bold ${remaining < 60 ? 'text-[#F85149]' : 'text-white'}`}>{formatTime(remaining)}</span>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-right"><div className="text-[10px] text-[#8B949E]">NET SCORE</div><div className={`text-lg font-mono font-bold ${netScore >= 0 ? 'text-[#3FB950]' : 'text-[#F85149]'}`}>${netScore.toLocaleString()}</div></div>
            <div className="text-right"><div className="text-[10px] text-[#8B949E]">THROUGHPUT</div><div className="text-lg font-mono font-bold text-cyan">{throughput}/min</div></div>
          </div>
        </div>
      </div>
      <div className="max-w-[1400px] mx-auto px-4 py-3">
        <AlertBanner alerts={state.alerts} />
        <div className="grid grid-cols-5 gap-2 my-3">{STAGES.map(s => <StagePanel key={s.id} stage={s} state={state} />)}</div>
        <BottleneckBar state={state} />
        <div className="grid grid-cols-12 gap-3 mt-3">
          <div className="col-span-4">
            <MetricsPanel state={state} />
            <div className="mt-3 bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2">Ovens</h3>
              {state.ovens.map(oven => <OvenDisplay key={oven.id} oven={oven} elapsed={state.elapsedTime} />)}
            </div>
          </div>
          <div className="col-span-8">
            <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3">
              <h3 className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2">Order Board</h3>
              <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {state.orders.sort((a, b) => { if (a.status === 'shipped') return 1; if (a.status === 'expired') return 1; return a.expiresAt - b.expiresAt; }).map(order => <OrderCard key={order.id} order={order} elapsed={state.elapsedTime} />)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── TEACHER VIEW ─────────────────────────────────────────────────────────────
function TeacherRoomCard({ roomCode, state, onAction }) {
  const netScore = state.revenue - state.penalties - (state.hasSecondOven ? SECOND_OVEN_COST : 0);
  const remaining = SIM_DURATION - (state.elapsedTime || 0);
  const totalOps = Object.keys(state.operators || {}).length;
  const shipped = state.shippedChips?.length || 0;
  const throughput = state.elapsedTime > 0 ? (shipped / (state.elapsedTime / 60)).toFixed(1) : '0.0';
  const expired = state.orders?.filter(o => o.status === 'expired').length || 0;
  const isRunning = state.phase === 'running';
  const isPaused = state.phase === 'paused';
  const isStaging = state.phase === 'staging';
  const isFinished = state.phase === 'finished';

  // Mini pipeline queue sizes
  const qs = {
    warehouse: state.orders?.filter(o => o.status === 'pending').length || 0,
    assembly: state.warehouseQueue?.length || 0,
    oven: state.ovenQueue?.length || 0,
    qa: (state.qaQueue?.length || 0) + (state.qaInProgress?.length || 0),
    logistics: state.finishedChips?.length || 0,
  };
  const maxQ = Math.max(...Object.values(qs), 1);

  return (
    <div className={`bg-[#161B22] border rounded-xl p-4 transition-all ${isRunning ? 'border-[#3FB950]/40' : isPaused ? 'border-[#F0B429]/40' : isFinished ? 'border-[#8B949E]/40' : 'border-[#30363D]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-mono font-black text-[#F0B429] tracking-wider">{roomCode}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
            isRunning ? 'bg-[#3FB950]/15 text-[#3FB950]' :
            isPaused ? 'bg-[#F0B429]/15 text-[#F0B429]' :
            isFinished ? 'bg-[#8B949E]/15 text-[#8B949E]' :
            'bg-[#58A6FF]/15 text-[#58A6FF]'
          }`}>{state.phase?.toUpperCase()}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${totalOps > 0 ? 'bg-[#3FB950]' : 'bg-[#30363D]'}`} />
          <span className="text-[10px] font-mono text-[#8B949E]">{totalOps} ops</span>
        </div>
      </div>

      {/* KPIs row */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="text-center">
          <div className="text-[8px] text-[#8B949E] uppercase">Score</div>
          <div className={`text-sm font-mono font-bold ${netScore >= 0 ? 'text-[#3FB950]' : 'text-[#F85149]'}`}>${netScore.toLocaleString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[8px] text-[#8B949E] uppercase">Throughput</div>
          <div className="text-sm font-mono font-bold text-cyan">{throughput}/m</div>
        </div>
        <div className="text-center">
          <div className="text-[8px] text-[#8B949E] uppercase">{isRunning || isPaused ? 'Time Left' : 'Round'}</div>
          <div className={`text-sm font-mono font-bold ${remaining < 60 && isRunning ? 'text-[#F85149]' : 'text-white'}`}>
            {isRunning || isPaused ? formatTime(remaining) : `${state.round || 0}/10`}
          </div>
        </div>
      </div>

      {/* Mini pipeline */}
      {(isRunning || isPaused || isFinished) && (
        <div className="mb-3">
          <div className="flex gap-0.5 items-end h-6">
            {STAGES.map(s => {
              const q = qs[s.id];
              const h = maxQ > 0 ? Math.max(3, (q / maxQ) * 24) : 3;
              const c = q > 6 ? '#F85149' : q > 3 ? '#F0B429' : '#3FB950';
              return (
                <div key={s.id} className="flex flex-col items-center gap-0.5 flex-1">
                  <div className="rounded-sm w-full transition-all" style={{ height: `${h}px`, backgroundColor: c }} />
                  <span className="text-[7px] text-[#8B949E] font-mono">{s.shortName}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex gap-3 text-[10px] mb-3">
        <span className="text-[#3FB950] font-mono">+${(state.revenue || 0).toLocaleString()}</span>
        <span className="text-[#F85149] font-mono">-${Math.round(state.penalties || 0).toLocaleString()}</span>
        {expired > 0 && <span className="text-[#F85149]">{expired} expired</span>}
        {(state.holdingCostAccrued || 0) > 0 && <span className="text-[#F0B429]">HC: ${Math.round(state.holdingCostAccrued).toLocaleString()}</span>}
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5">
        {isStaging && (
          <button onClick={() => onAction(roomCode, { type: 'START_SIMULATION' })}
            className="flex-1 py-1.5 text-[10px] font-bold bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/30 rounded-lg hover:bg-[#3FB950]/30 transition-colors">
            Start
          </button>
        )}
        {isRunning && (
          <>
            <button onClick={() => onAction(roomCode, { type: 'PAUSE_SIMULATION' })}
              className="flex-1 py-1.5 text-[10px] font-bold bg-[#F0B429]/20 text-[#F0B429] border border-[#F0B429]/30 rounded-lg hover:bg-[#F0B429]/30 transition-colors">
              Pause
            </button>
            <button onClick={() => onAction(roomCode, { type: 'INJECT_ORDER', urgency: 'EXPRESS' })}
              className="flex-1 py-1.5 text-[10px] font-bold bg-[#F85149]/20 text-[#F85149] border border-[#F85149]/30 rounded-lg hover:bg-[#F85149]/30 transition-colors">
              Inject Rush
            </button>
          </>
        )}
        {isPaused && (
          <button onClick={() => onAction(roomCode, { type: 'RESUME_SIMULATION' })}
            className="flex-1 py-1.5 text-[10px] font-bold bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/30 rounded-lg hover:bg-[#3FB950]/30 transition-colors">
            Resume
          </button>
        )}
        {isFinished && (
          <div className="flex-1 py-1.5 text-[10px] font-bold text-[#8B949E] text-center">Simulation Complete</div>
        )}
      </div>
    </div>
  );
}

function TeacherView({ teacherRooms, wsSend }) {
  const [configStockMultiplier, setConfigStockMultiplier] = useState(1.0);
  const [configHoldingCost, setConfigHoldingCost] = useState(0);
  const [configChipWeights, setConfigChipWeights] = useState({ ALPHA: 1, BETA: 1, GAMMA: 2 });
  const [showConfig, setShowConfig] = useState(false);
  const [competitionStarted, setCompetitionStarted] = useState(false);

  const roomEntries = Object.entries(teacherRooms).sort(([, a], [, b]) => {
    const order = { running: 0, paused: 1, staging: 2, lobby: 3, finished: 4 };
    return (order[a.phase] || 5) - (order[b.phase] || 5);
  });

  const handleAction = (roomCode, action) => {
    wsSend({ type: 'teacher_action', room: roomCode, action });
  };

  const currentConfig = { type: 'SET_GAME_CONFIG', stockMultiplier: configStockMultiplier, holdingCostRate: configHoldingCost, chipWeights: configChipWeights };

  const applyConfigToAll = () => {
    for (const [roomCode] of roomEntries) {
      handleAction(roomCode, currentConfig);
    }
  };

  // Competition controls
  const stagingRooms = roomEntries.filter(([, s]) => s.phase === 'staging');
  const runningRooms = roomEntries.filter(([, s]) => s.phase === 'running');
  const pausedRooms = roomEntries.filter(([, s]) => s.phase === 'paused');
  const activeRooms = roomEntries.filter(([, s]) => s.phase === 'running' || s.phase === 'paused');
  const finishedRooms = roomEntries.filter(([, s]) => s.phase === 'finished');
  const scoredRooms = roomEntries.filter(([, s]) => s.phase === 'running' || s.phase === 'finished' || s.phase === 'paused');

  // Auto-reset competition lock when all rooms finish
  if (competitionStarted && roomEntries.length > 0 && activeRooms.length === 0 && finishedRooms.length > 0) {
    // All rooms finished — will reset on next render via effect below
  }
  useEffect(() => {
    if (competitionStarted && roomEntries.length > 0 && activeRooms.length === 0 && finishedRooms.length > 0) {
      setCompetitionStarted(false);
    }
  }, [competitionStarted, roomEntries.length, activeRooms.length, finishedRooms.length]);

  const handleStartAll = () => {
    for (const [roomCode] of stagingRooms) {
      handleAction(roomCode, currentConfig);
      handleAction(roomCode, { type: 'START_SIMULATION' });
    }
    setCompetitionStarted(true);
  };

  const handlePauseAll = () => {
    for (const [roomCode] of runningRooms) {
      handleAction(roomCode, { type: 'PAUSE_SIMULATION' });
    }
  };

  const handleResumeAll = () => {
    for (const [roomCode] of pausedRooms) {
      handleAction(roomCode, { type: 'RESUME_SIMULATION' });
    }
  };

  // Chip weight presets
  const CHIP_WEIGHT_PRESETS = [
    { label: 'Two-Coin', weights: { ALPHA: 1, BETA: 1, GAMMA: 2 }, desc: 'A:25% B:25% G:50%' },
    { label: 'Equal', weights: { ALPHA: 1, BETA: 1, GAMMA: 1 }, desc: 'A:33% B:33% G:33%' },
    { label: 'No GAMMA', weights: { ALPHA: 1, BETA: 1, GAMMA: 0 }, desc: 'A:50% B:50% G:0%' },
    { label: 'GAMMA Heavy', weights: { ALPHA: 1, BETA: 1, GAMMA: 4 }, desc: 'A:17% B:17% G:67%' },
  ];

  const chipWeightTotal = Object.values(configChipWeights).reduce((s, v) => s + v, 0) || 1;

  // Aggregate stats
  const totalRooms = roomEntries.length;
  const totalRevenue = roomEntries.reduce((sum, [, s]) => sum + (s.revenue || 0), 0);
  const totalOps = roomEntries.reduce((sum, [, s]) => sum + Object.keys(s.operators || {}).length, 0);

  // Leaderboard data
  const leaderboard = scoredRooms
    .map(([code, s]) => {
      const score = (s.revenue || 0) - (s.penalties || 0) - (s.hasSecondOven ? SECOND_OVEN_COST : 0);
      const tp = s.elapsedTime > 0 ? ((s.shippedChips?.length || 0) / (s.elapsedTime / 60)).toFixed(1) : '0.0';
      const fulfilled = s.orders?.filter(o => o.status === 'shipped').length || 0;
      const totalOrders = s.orders?.length || 0;
      const fulfillRate = totalOrders > 0 ? Math.round((fulfilled / totalOrders) * 100) : 0;
      return { code, score, tp, fulfillRate, phase: s.phase, ops: Object.keys(s.operators || {}).length, round: s.round || 0 };
    })
    .sort((a, b) => b.score - a.score);

  const leaderScore = leaderboard.length > 0 ? leaderboard[0].score : 0;
  const allFinished = scoredRooms.length > 0 && scoredRooms.every(([, s]) => s.phase === 'finished');

  return (
    <div className="min-h-screen bg-[#0D1117] text-white">
      {/* Top Bar */}
      <div className="bg-[#161B22] border-b border-[#30363D] px-4 py-2">
        <div className="flex items-center justify-between max-w-[1400px] mx-auto">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-black tracking-wider text-[#F0B429]">LEGO CHIP FACTORY</h1>
            <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded font-bold">TEACHER</span>
            {competitionStarted && <span className="text-[10px] px-2 py-0.5 bg-[#F0B429]/20 text-[#F0B429] rounded-full font-bold animate-pulse">COMPETITION ACTIVE</span>}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-[#0D1117] px-2.5 py-1 rounded-lg border border-[#21262D]">
              <span className="text-[10px] text-[#8B949E]">Rooms</span>
              <span className="text-[10px] font-bold font-mono text-white">{totalRooms}</span>
              <span className="text-[10px] text-[#3FB950]">({activeRooms.length} active)</span>
            </div>
            <div className="flex items-center gap-1.5 bg-[#0D1117] px-2.5 py-1 rounded-lg border border-[#21262D]">
              <span className="text-[10px] text-[#8B949E]">Operators</span>
              <span className="text-[10px] font-bold font-mono text-white">{totalOps}</span>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[#8B949E]">Total Revenue</div>
              <div className="text-sm font-mono font-bold text-[#3FB950]">${totalRevenue.toLocaleString()}</div>
            </div>
            {/* Competition quick actions */}
            {stagingRooms.length > 0 && (
              <button onClick={handleStartAll}
                className="px-3 py-1.5 text-[10px] font-bold bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/30 rounded-lg hover:bg-[#3FB950]/30 transition-colors">
                Start All ({stagingRooms.length})
              </button>
            )}
            {runningRooms.length > 0 && (
              <button onClick={handlePauseAll}
                className="px-3 py-1.5 text-[10px] font-bold bg-[#F0B429]/20 text-[#F0B429] border border-[#F0B429]/30 rounded-lg hover:bg-[#F0B429]/30 transition-colors">
                Pause All
              </button>
            )}
            {pausedRooms.length > 0 && (
              <button onClick={handleResumeAll}
                className="px-3 py-1.5 text-[10px] font-bold bg-[#3FB950]/20 text-[#3FB950] border border-[#3FB950]/30 rounded-lg hover:bg-[#3FB950]/30 transition-colors">
                Resume All
              </button>
            )}
            <button onClick={() => setShowConfig(!showConfig)}
              className={`px-3 py-1.5 text-[10px] font-bold border rounded-lg transition-colors ${showConfig ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : 'bg-[#0D1117] text-[#8B949E] border-[#30363D] hover:border-purple-500/30 hover:text-purple-400'}`}>
              Config
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-4 py-4">
        {/* Config Panel */}
        {showConfig && (
          <div className={`bg-[#161B22] border rounded-xl p-4 mb-4 animate-slide-in ${competitionStarted ? 'border-[#F0B429]/30 opacity-60' : 'border-purple-500/30'}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-purple-400 uppercase tracking-wider">Game Configuration</h3>
              {competitionStarted && <span className="text-[9px] text-[#F0B429] font-bold">LOCKED — Competition Active</span>}
            </div>
            <fieldset disabled={competitionStarted}>
            <div className="grid grid-cols-3 gap-4">
              {/* Stock Multiplier */}
              <div>
                <label className="text-[10px] text-[#8B949E] uppercase font-bold mb-2 block">Starting Stock Multiplier</label>
                <div className="flex gap-1.5">
                  {[0.5, 0.75, 1.0, 1.5, 2.0].map(m => (
                    <button key={m} onClick={() => setConfigStockMultiplier(m)}
                      className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg border transition-colors ${configStockMultiplier === m ? 'bg-purple-500/20 text-purple-400 border-purple-500/40' : 'bg-[#0D1117] text-[#8B949E] border-[#30363D] hover:border-purple-500/30'}`}>
                      {m}x
                    </button>
                  ))}
                </div>
                <p className="text-[8px] text-[#30363D] mt-1">Base stock: {Object.entries(INITIAL_STOCK).map(([c, v]) => `${c}:${Math.round(v * configStockMultiplier)}`).join(', ')}</p>
              </div>

              {/* Holding Cost */}
              <div>
                <label className="text-[10px] text-[#8B949E] uppercase font-bold mb-2 block">Holding Cost ($/unit/tick)</label>
                <div className="flex gap-1.5">
                  {[0, 0.25, 0.5, 1.0, 2.0].map(c => (
                    <button key={c} onClick={() => setConfigHoldingCost(c)}
                      className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg border transition-colors ${configHoldingCost === c ? 'bg-purple-500/20 text-purple-400 border-purple-500/40' : 'bg-[#0D1117] text-[#8B949E] border-[#30363D] hover:border-purple-500/30'}`}>
                      ${c}
                    </button>
                  ))}
                </div>
                <p className="text-[8px] text-[#30363D] mt-1">{configHoldingCost > 0 ? `~$${Math.round(Object.values(INITIAL_STOCK).reduce((s, v) => s + v, 0) * configStockMultiplier * configHoldingCost)}/tick at full stock` : 'Disabled — no inventory drain'}</p>
              </div>

              {/* Chip Weight Presets */}
              <div>
                <label className="text-[10px] text-[#8B949E] uppercase font-bold mb-2 block">Order Chip Distribution</label>
                <div className="flex gap-1.5">
                  {CHIP_WEIGHT_PRESETS.map(p => {
                    const match = p.weights.ALPHA === configChipWeights.ALPHA && p.weights.BETA === configChipWeights.BETA && p.weights.GAMMA === configChipWeights.GAMMA;
                    return (
                      <button key={p.label} onClick={() => setConfigChipWeights({ ...p.weights })}
                        className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg border transition-colors ${match ? 'bg-purple-500/20 text-purple-400 border-purple-500/40' : 'bg-[#0D1117] text-[#8B949E] border-[#30363D] hover:border-purple-500/30'}`}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[8px] text-[#30363D] mt-1">
                  A:{Math.round((configChipWeights.ALPHA / chipWeightTotal) * 100)}%
                  B:{Math.round((configChipWeights.BETA / chipWeightTotal) * 100)}%
                  G:{Math.round((configChipWeights.GAMMA / chipWeightTotal) * 100)}%
                </p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={applyConfigToAll}
                className="px-4 py-1.5 text-[10px] font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-lg hover:bg-purple-500/30 transition-colors">
                Apply to All Rooms
              </button>
              <p className="text-[9px] text-[#8B949E] self-center">Sets stock, holding cost, and chip distribution for all rooms. Best applied during staging.</p>
            </div>
            </fieldset>
          </div>
        )}

        {/* Room Grid */}
        {roomEntries.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">🎓</div>
            <h2 className="text-xl font-bold text-[#F0B429] mb-2">No Active Rooms</h2>
            <p className="text-sm text-[#8B949E]">Waiting for Directors to create rooms...</p>
            <div className="flex justify-center gap-1 mt-4">
              <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {roomEntries.map(([code, roomState]) => (
              <TeacherRoomCard key={code} roomCode={code} state={roomState} onAction={handleAction} />
            ))}
          </div>
        )}

        {/* Leaderboard — always visible when rooms have scores */}
        {leaderboard.length > 0 && (
          <div className={`mt-4 bg-[#161B22] border rounded-xl p-4 ${allFinished ? 'border-[#F0B429]/50' : 'border-[#30363D]'}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider">
                {allFinished ? 'Competition Complete — Final Rankings' : 'Leaderboard'}
              </h3>
              {allFinished && leaderboard.length > 0 && (
                <span className="text-[10px] font-bold text-[#F0B429]">Winner: {leaderboard[0].code}</span>
              )}
            </div>
            <div className="space-y-1.5">
              {leaderboard.map((entry, i) => (
                <div key={entry.code} className={`flex items-center justify-between px-3 py-2 rounded-lg ${i === 0 ? 'bg-[#F0B429]/10 border border-[#F0B429]/30' : 'bg-[#0D1117] border border-[#21262D]'}`}>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-bold font-mono ${i === 0 ? 'text-[#F0B429]' : 'text-[#8B949E]'}`}>#{i + 1}</span>
                    <span className="text-sm font-mono font-bold text-white tracking-wider">{entry.code}</span>
                    <span className="text-[10px] text-[#8B949E]">{entry.ops} ops</span>
                    <span className="text-[10px] text-[#8B949E]">R{entry.round}/10</span>
                    {entry.phase === 'finished' && <span className="text-[8px] px-1 py-0.5 bg-[#8B949E]/15 text-[#8B949E] rounded">DONE</span>}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] font-mono text-[#8B949E]">{entry.fulfillRate}% filled</span>
                    <span className="text-[10px] font-mono text-cyan">{entry.tp}/min</span>
                    {i > 0 && <span className="text-[10px] font-mono text-[#F85149]">{entry.score - leaderScore >= 0 ? '' : ''}{(entry.score - leaderScore).toLocaleString()}</span>}
                    <span className={`text-sm font-mono font-bold ${entry.score >= 0 ? 'text-[#3FB950]' : 'text-[#F85149]'}`}>${entry.score.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
            {/* Competition complete summary */}
            {allFinished && leaderboard.length > 1 && (
              <div className="mt-3 pt-3 border-t border-[#30363D] grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-[8px] text-[#8B949E] uppercase">Best Throughput</div>
                  <div className="text-xs font-mono font-bold text-cyan">
                    {[...leaderboard].sort((a, b) => parseFloat(b.tp) - parseFloat(a.tp))[0].code} ({[...leaderboard].sort((a, b) => parseFloat(b.tp) - parseFloat(a.tp))[0].tp}/min)
                  </div>
                </div>
                <div>
                  <div className="text-[8px] text-[#8B949E] uppercase">Best Fulfillment</div>
                  <div className="text-xs font-mono font-bold text-[#3FB950]">
                    {[...leaderboard].sort((a, b) => b.fulfillRate - a.fulfillRate)[0].code} ({[...leaderboard].sort((a, b) => b.fulfillRate - a.fulfillRate)[0].fulfillRate}%)
                  </div>
                </div>
                <div>
                  <div className="text-[8px] text-[#8B949E] uppercase">Highest Score</div>
                  <div className="text-xs font-mono font-bold text-[#F0B429]">
                    {leaderboard[0].code} (${leaderboard[0].score.toLocaleString()})
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DEBRIEF SCREEN ──────────────────────────────────────────────────────────
function DebriefScreen({ state, onRestart }) {
  const el = state.elapsedTime || SIM_DURATION;
  const netScore = state.revenue - state.penalties - (state.hasSecondOven ? SECOND_OVEN_COST : 0);
  const totalChips = state.shippedChips.length;
  const tp = el > 0 ? (totalChips / (el / 60)).toFixed(1) : '0.0';
  const tO = state.orders.length, shipped = state.orders.filter(o => o.status === 'shipped').length, expired = state.orders.filter(o => o.status === 'expired').length;
  const fR = tO > 0 ? ((shipped / tO) * 100).toFixed(0) : 0;
  const aBS = state.ovenBatches.length > 0 ? (state.ovenBatches.reduce((s, b) => s + b.size, 0) / state.ovenBatches.length).toFixed(1) : '0';
  const oE = state.ovenBatches.length > 0 ? ((aBS / OVEN_CAPACITY) * 100).toFixed(0) : 0;
  const aLT = state.orderLeadTimes.length > 0 ? state.orderLeadTimes.reduce((s, t) => s + t, 0) / state.orderLeadTimes.length : 0;
  const oRT = state.ovenBatches.reduce((s, b) => s + b.weldTime, 0);
  const oU = el > 0 ? ((oRT / el) * 100).toFixed(0) : 0;
  const tEC = state.ovenBatches.reduce((s, b) => s + (OVEN_CAPACITY - b.size), 0);
  const aCV = totalChips > 0 ? state.revenue / totalChips : 100;
  const wIR = Math.round(tEC * aCV);
  const mIS = Object.entries(state.stageIdleTime).sort(([, a], [, b]) => b - a)[0];

  return (
    <div className="min-h-screen bg-[#0D1117] text-white flex items-center justify-center p-8">
      <div className="max-w-3xl w-full animate-fade-in">
        <div className="text-center mb-8"><h1 className="text-3xl font-black text-[#F0B429] tracking-wider mb-2">SIMULATION COMPLETE</h1><p className="text-[#8B949E]">10-minute production run finished</p></div>
        <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-6 text-center mb-6">
          <div className="text-[10px] text-[#8B949E] uppercase tracking-wider mb-1">Final Net Score</div>
          <div className={`text-5xl font-mono font-black ${netScore >= 0 ? 'text-[#3FB950]' : 'text-[#F85149]'}`}>${netScore.toLocaleString()}</div>
          <div className="flex justify-center gap-6 mt-3 text-sm">
            <span className="text-[#3FB950]">+${state.revenue.toLocaleString()} revenue</span>
            <span className="text-[#F85149]">-${state.penalties.toLocaleString()} penalties</span>
            {state.hasSecondOven && <span className="text-[#F85149]">-$2,000 oven</span>}
            {(state.holdingCostAccrued || 0) > 0 && <span className="text-[#F0B429]">-${Math.round(state.holdingCostAccrued).toLocaleString()} holding</span>}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[['Chips Shipped',totalChips,'#3FB950'],['Throughput',`${tp}/min`,'#22D3EE'],['Fulfill Rate',`${fR}%`,'#F0B429'],['Orders',`${shipped}/${tO}`,'#8B949E'],['Oven Batches',state.ovenBatches.length,'#F0B429'],['Oven Efficiency',`${oE}%`,'#F0B429'],['Oven Util.',`${oU}%`,'#22D3EE'],['Avg Lead',aLT > 0 ? formatTime(aLT) : '-','#8B949E']].map(([l,v,c],i) => (
            <div key={i} className="bg-[#161B22] border border-[#30363D] rounded-lg p-3 text-center"><div className="text-[10px] text-[#8B949E] uppercase mb-1">{l}</div><div className="text-xl font-mono font-bold" style={{color:c}}>{v}</div></div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
            <h3 className="text-xs font-bold text-[#F0B429] uppercase tracking-wider mb-3">Bottleneck Analysis</h3>
            <div className="space-y-2">{Object.entries(state.stageIdleTime).sort(([,a],[,b]) => a - b).map(([s, t]) => <div key={s} className="flex items-center justify-between text-xs"><span className="text-[#8B949E] capitalize">{s}</span><span className="font-mono text-white">{formatTime(t)} idle</span></div>)}</div>
            {mIS && <p className="text-[10px] text-[#F85149] mt-2">Biggest bottleneck: {mIS[0]} ({formatTime(mIS[1])} idle)</p>}
          </div>
          <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
            <h3 className="text-xs font-bold text-[#22D3EE] uppercase tracking-wider mb-3">What-If Analysis</h3>
            <div className="space-y-2 text-xs">
              <p className="text-[#8B949E]">If every oven batch had been full ({OVEN_CAPACITY} chips):</p>
              <p className="text-white">+{tEC} additional chips welded</p>
              <p className="text-[#3FB950] font-mono font-bold">≈ +${wIR.toLocaleString()} potential revenue</p>
              {!state.hasSecondOven && <p className="text-[#F0B429] mt-2 text-[10px]">You did not purchase the 2nd oven.</p>}
              {(state.holdingCostAccrued || 0) > 0 && (
                <div className="mt-2 pt-2 border-t border-[#21262D]">
                  <p className="text-[#F0B429] text-[10px] font-bold">Holding Cost Impact</p>
                  <p className="text-[#8B949E] text-[10px]">Total holding cost: <span className="text-[#F85149] font-mono">${Math.round(state.holdingCostAccrued).toLocaleString()}</span></p>
                  <p className="text-[#8B949E] text-[10px]">Rate: ${state.holdingCostRate}/unit/tick — lean inventory reduces this cost</p>
                </div>
              )}
            </div>
          </div>
        </div>
        {expired > 0 && <div className="bg-[#F85149]/10 border border-[#F85149]/30 rounded-lg p-3 mb-6"><p className="text-xs text-[#F85149]"><strong>{expired} orders expired</strong> — ${expired * EXPIRED_PENALTY} in penalties.</p></div>}
        <div className="text-center"><button onClick={onRestart} className="px-8 py-3 bg-[#F0B429] text-[#0D1117] font-bold rounded-lg hover:bg-[#F0B429]/90 transition-colors text-sm">Run Another Simulation</button></div>
      </div>
    </div>
  );
}

// ─── LOBBY ───────────────────────────────────────────────────────────────────
function Lobby({ onJoin, urlRoom }) {
  const [phase, setPhase] = useState(urlRoom ? 'join' : 'home'); // home | join | create | teacher_auth
  const [roomCode, setRoomCode] = useState(urlRoom || '');
  const [name, setName] = useState('');
  const [role, setRole] = useState(urlRoom ? 'operator' : 'director');
  const [activeSessions, setActiveSessions] = useState([]);
  const [joinError, setJoinError] = useState('');
  const [teacherPassword, setTeacherPassword] = useState('');
  const [teacherAuthError, setTeacherAuthError] = useState('');

  // Fetch active rooms from WebSocket server
  useEffect(() => {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'get_rooms' })); };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'room_list') setActiveSessions(msg.rooms);
        } catch {}
        ws.close();
      };
      ws.onerror = () => {};
    } catch {}
    return () => { if (ws) ws.close(); };
  }, []);

  const handleCreate = () => {
    const code = generateRoomCode();
    setRoomCode(code);
    setRole('director');
    setPhase('create');
  };

  const handleJoinRoom = () => {
    if (roomCode.length !== 4) { setJoinError('Enter a 4-letter room code'); return; }
    setJoinError('');
    setPhase('join');
  };

  const handleSubmit = () => {
    if (role === 'teacher') {
      setPhase('teacher_auth');
      return;
    }
    if (!name.trim() || !roomCode) return;
    onJoin(name.trim(), role, roomCode.toUpperCase());
  };

  const handleTeacherAuth = () => {
    if (!name.trim() || !teacherPassword.trim()) return;
    setTeacherAuthError('');
    // Try to authenticate via WebSocket
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'teacher_join', password: teacherPassword }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'teacher_auth_ok') {
          ws.close();
          onJoin(name.trim(), 'teacher', '__teacher__', teacherPassword);
        } else if (msg.type === 'teacher_auth_fail') {
          ws.close();
          setTeacherAuthError('Invalid password');
        }
      } catch {}
    };
    ws.onerror = () => { setTeacherAuthError('Connection failed'); };
  };

  // Teacher authentication screen
  if (phase === 'teacher_auth') return (
    <div className="min-h-screen bg-[#0D1117] text-white flex items-center justify-center">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">🎓</div>
          <h1 className="text-xl font-black tracking-wider text-purple-400 mb-1">TEACHER LOGIN</h1>
          <p className="text-xs text-[#8B949E]">Enter the teacher password to access the dashboard</p>
        </div>
        <div className="bg-[#161B22] border border-purple-500/30 rounded-xl p-6">
          <div className="mb-4">
            <label className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-1.5 block">Password</label>
            <input type="password" value={teacherPassword} onChange={e => { setTeacherPassword(e.target.value); setTeacherAuthError(''); }}
              placeholder="Enter teacher password"
              onKeyDown={e => e.key === 'Enter' && handleTeacherAuth()}
              className="w-full bg-[#0D1117] border border-[#30363D] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#30363D] focus:border-purple-500 focus:outline-none transition-colors" />
            {teacherAuthError && <p className="text-[10px] text-[#F85149] mt-1.5">{teacherAuthError}</p>}
          </div>
          <button onClick={handleTeacherAuth} disabled={!teacherPassword.trim()}
            className="w-full py-3 bg-purple-500 text-white font-bold rounded-lg text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:bg-purple-500/90 transition-colors">
            Enter Teacher Dashboard
          </button>
        </div>
        <button onClick={() => { setPhase(roomCode ? 'join' : 'create'); setTeacherPassword(''); setTeacherAuthError(''); }}
          className="w-full mt-3 py-2 text-xs text-[#8B949E] hover:text-white transition-colors">
          ← Back
        </button>
      </div>
    </div>
  );

  // Home screen — Create or Join
  if (phase === 'home') return (
    <div className="min-h-screen bg-[#0D1117] text-white flex items-center justify-center">
      <div className="w-full max-w-lg animate-fade-in">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <svg width="80" height="80" viewBox="0 0 80 80">
              <rect x="5" y="25" width="70" height="50" rx="4" fill="#161B22" stroke="#F0B429" strokeWidth="2"/>
              <rect x="15" y="10" width="50" height="20" rx="3" fill="#161B22" stroke="#30363D" strokeWidth="1.5"/>
              <rect x="25" y="3" width="30" height="12" rx="2" fill="#F0B429" opacity="0.3"/>
              <rect x="15" y="35" width="12" height="10" rx="1" fill="#F0B429" opacity="0.2"/>
              <rect x="34" y="35" width="12" height="10" rx="1" fill="#22D3EE" opacity="0.2"/>
              <rect x="53" y="35" width="12" height="10" rx="1" fill="#3FB950" opacity="0.2"/>
              <rect x="32" y="55" width="16" height="20" rx="2" fill="#21262D" stroke="#30363D" strokeWidth="1"/>
            </svg>
          </div>
          <h1 className="text-2xl font-black tracking-wider text-[#F0B429] mb-1">LEGO MICROCHIP FACTORY</h1>
          <p className="text-xs text-[#8B949E]">MBA Operations Management Simulation</p>
        </div>

        <div className="space-y-3">
          <button onClick={handleCreate}
            className="w-full bg-[#161B22] border-2 border-[#F0B429] rounded-xl p-5 text-left hover:bg-[#F0B429]/5 transition-all group">
            <div className="flex items-center gap-4">
              <div className="text-3xl">🎯</div>
              <div className="flex-1">
                <div className="text-sm font-bold text-[#F0B429] group-hover:text-white transition-colors">Create New Factory</div>
                <div className="text-xs text-[#8B949E] mt-0.5">Start a simulation as Director. Get a room code for operators to join.</div>
              </div>
              <div className="text-[#30363D] group-hover:text-[#F0B429] transition-colors text-lg">→</div>
            </div>
          </button>

          <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-5">
            <div className="flex items-center gap-4 mb-3">
              <div className="text-3xl">🔧</div>
              <div>
                <div className="text-sm font-bold text-white">Join Existing Factory</div>
                <div className="text-xs text-[#8B949E] mt-0.5">Enter the room code from your Director.</div>
              </div>
            </div>
            <div className="flex gap-2">
              <input type="text" value={roomCode} onChange={e => { setRoomCode(e.target.value.toUpperCase().slice(0, 4)); setJoinError(''); }}
                placeholder="ROOM CODE" maxLength={4}
                className="flex-1 bg-[#0D1117] border border-[#30363D] rounded-lg px-4 py-2.5 text-center text-lg font-mono font-bold text-white tracking-[0.3em] placeholder-[#30363D] focus:border-[#F0B429] focus:outline-none transition-colors uppercase" />
              <button onClick={handleJoinRoom} disabled={roomCode.length !== 4}
                className="px-6 py-2.5 bg-[#F0B429] text-[#0D1117] font-bold rounded-lg text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0B429]/90 transition-colors">
                Join
              </button>
            </div>
            {joinError && <p className="text-[10px] text-[#F85149] mt-1.5">{joinError}</p>}
          </div>
        </div>

        {/* Active sessions */}
        {activeSessions.length > 0 && (
          <div className="mt-6">
            <h3 className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider mb-2">Active Sessions</h3>
            <div className="space-y-1.5">
              {activeSessions.map(s => (
                <button key={s.room} onClick={() => { setRoomCode(s.room); setRole('operator'); setPhase('join'); }}
                  className="w-full flex items-center justify-between bg-[#161B22] border border-[#30363D] rounded-lg px-4 py-2.5 text-left hover:border-[#F0B429] transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="text-base font-mono font-bold text-[#F0B429] tracking-wider">{s.room}</span>
                    <span className="text-[10px] text-[#8B949E]">Round {s.round}/10</span>
                    <span className="text-[10px] text-[#3FB950]">{s.opCount} operators</span>
                  </div>
                  <span className="text-xs text-[#8B949E]">{formatTime(s.elapsed)} elapsed</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 grid grid-cols-3 gap-3">
          {[{chip:'ALPHA',desc:'Square 2x2 — 4 pcs — $100'},{chip:'BETA',desc:'Rectangle 2x4 — 8 pcs — $250'},{chip:'GAMMA',desc:'L-Shape — 12 pcs — $500'}].map(c => (
            <div key={c.chip} className="bg-[#161B22] border border-[#30363D] rounded-lg p-3 text-center">
              <ChipIcon chipType={c.chip} size={24} /><div className="text-[10px] font-bold text-white mt-1">CHIP {c.chip}</div><div className="text-[8px] text-[#8B949E]">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // Join/Create screen — enter name + pick role
  return (
    <div className="min-h-screen bg-[#0D1117] text-white flex items-center justify-center">
      <div className="w-full max-w-lg animate-fade-in">
        <div className="text-center mb-6">
          <h1 className="text-xl font-black tracking-wider text-[#F0B429] mb-2">LEGO MICROCHIP FACTORY</h1>
          <div className="inline-flex items-center gap-2 bg-[#161B22] border border-[#F0B429]/40 rounded-xl px-5 py-2.5">
            <span className="text-[10px] text-[#8B949E] uppercase font-bold">Room</span>
            <span className="text-2xl font-mono font-black text-[#F0B429] tracking-[0.4em]">{roomCode}</span>
          </div>
          {phase === 'create' && (
            <p className="text-xs text-[#8B949E] mt-2">Share this code with your team to join!</p>
          )}
        </div>

        <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-6">
          <div className="mb-4">
            <label className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-1.5 block">Your Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Enter your name"
              onKeyDown={e => e.key === 'Enter' && name.trim() && handleSubmit()}
              className="w-full bg-[#0D1117] border border-[#30363D] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#30363D] focus:border-[#F0B429] focus:outline-none transition-colors" />
          </div>
          <div className="mb-6">
            <label className="text-xs font-bold text-[#8B949E] uppercase tracking-wider mb-2 block">Select Role</label>
            <div className="grid grid-cols-3 gap-2">
              {[{ id: 'director', icon: '🎯', label: 'Director', desc: 'Assign operators. Observe production. Strategy only.' },
                { id: 'operator', icon: '🔧', label: 'Operator', desc: 'Hands-on! Build chips, pick bricks, ship orders.' },
                { id: 'teacher', icon: '🎓', label: 'Teacher', desc: 'Monitor all rooms. Control sims. Set parameters.' }
              ].map(r => (
                <button key={r.id} onClick={() => setRole(r.id)} className={`p-3 rounded-lg border text-left transition-all ${role === r.id ? 'border-[#F0B429] bg-[#F0B429]/10' : 'border-[#30363D] bg-[#0D1117] hover:border-[#8B949E]'}`}>
                  <div className="text-2xl mb-1">{r.icon}</div>
                  <div className="text-xs font-bold text-white">{r.label}</div>
                  <div className="text-[10px] text-[#8B949E] mt-0.5">{r.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <button onClick={handleSubmit} disabled={!name.trim()}
            className="w-full py-3 bg-[#F0B429] text-[#0D1117] font-bold rounded-lg text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0B429]/90 transition-colors">
            {role === 'teacher' ? 'Continue to Login' : 'Enter Factory'}
          </button>
        </div>

        <button onClick={() => { setPhase('home'); setRoomCode(''); }} className="w-full mt-3 py-2 text-xs text-[#8B949E] hover:text-white transition-colors">
          ← Back
        </button>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [roomCode, setRoomCode] = useState(getRoomFromURL);
  const [state, dispatch] = useReducer(gameReducer, roomCode, createInitialState);
  const [role, setRole] = useState(null);
  const [playerName, setPlayerName] = useState('');
  const [playerId] = useState(genId);
  const [teacherRooms, setTeacherRooms] = useState({});
  const [teacherPwd, setTeacherPwd] = useState('');
  const intervalRef = useRef(null);
  const wsRef = useRef(null);
  const stateRef = useRef(state);
  const roleRef = useRef(role);

  // Keep refs in sync
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { roleRef.current = role; }, [role]);

  // ── WEBSOCKET CONNECTION ──
  useEffect(() => {
    if (!role) return;
    // Non-teacher roles need a room code
    if (role !== 'teacher' && !roomCode) return;

    let ws;
    let reconnectTimer;
    let retryDelay = 500;

    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay = 500;
        if (roleRef.current === 'teacher') {
          // Teacher authenticates with password
          ws.send(JSON.stringify({ type: 'teacher_join', password: teacherPwd }));
        } else {
          // Join the room
          ws.send(JSON.stringify({ type: 'join', room: roomCode, role, id: playerId, name: playerName }));
          // If Director, send current state so server has it for late joiners
          if (roleRef.current === 'director' && stateRef.current.phase !== 'lobby') {
            ws.send(JSON.stringify({ type: 'state_update', state: stateRef.current }));
          }
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case 'state_update':
            // Non-directors receive state from Director via server
            if (roleRef.current !== 'director' && roleRef.current !== 'teacher') {
              dispatch({ type: 'SET_STATE', state: msg.state });
            }
            break;
          case 'room_state':
            // Teacher receives state from all rooms
            if (roleRef.current === 'teacher') {
              setTeacherRooms(prev => ({ ...prev, [msg.room]: msg.state }));
            }
            break;
          case 'action':
            // Director receives actions from operators/teacher via server
            if (roleRef.current === 'director') {
              dispatch(msg.action);
            }
            break;
          case 'client_joined':
            break;
          case 'client_left':
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Reconnect with backoff
        reconnectTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 5000);
          connect();
        }, retryDelay);
      };

      ws.onerror = () => { ws.close(); };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (ws) { ws.onclose = null; ws.close(); }
      wsRef.current = null;
    };
  }, [role, roomCode, playerId, playerName, teacherPwd]);

  // ── DIRECTOR: broadcast state via WebSocket on every change ──
  useEffect(() => {
    if (role !== 'director') return;
    if (state.phase === 'lobby') return;
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state_update', state }));
    }
  }, [state, role]);

  // ── TICK TIMER ──
  useEffect(() => {
    if (state.phase !== 'running') { clearInterval(intervalRef.current); return; }
    intervalRef.current = setInterval(() => { dispatch({ type: 'TICK', elapsed: (Date.now() - state.startTime) / 1000 }); }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [state.phase, state.startTime]);

  // ── REMOTE DISPATCH: operators send actions to Director via WebSocket ──
  const remoteDispatch = useCallback((action) => {
    dispatch(action); // Optimistic local update
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'action', action }));
    }
  }, []);

  const handleJoin = useCallback((name, selectedRole, room, password) => {
    setPlayerName(name);
    setRole(selectedRole);
    setRoomCode(room);

    if (selectedRole === 'teacher') {
      setTeacherPwd(password || '');
      // Teacher doesn't join a specific room — WS effect will handle auth
      return;
    }

    // Update URL to include room code
    const url = new URL(window.location);
    url.searchParams.set('room', room);
    window.history.replaceState({}, '', url);

    if (selectedRole === 'operator') {
      // Operator registers — server will send current state on WS connect
      // Also dispatch ADD_OPERATOR as a remote action so Director picks it up
      const addAction = { type: 'ADD_OPERATOR', id: playerId, name, stage: null, isBot: false };
      dispatch(addAction);
      // WebSocket connect effect will fire (role changed) — send action after connect
      setTimeout(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'action', action: addAction }));
        }
      }, 600);
      return;
    }

    if (selectedRole === 'director') {
      dispatch({ type: 'SET_STATE', state: createInitialState(room) });
      dispatch({ type: 'START_STAGING' });
    }
  }, [playerId]);

  const handleRestart = useCallback(() => {
    dispatch({ type: 'SET_STATE', state: createInitialState() });
    setRole(null); setPlayerName('');
    const url = new URL(window.location);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
    setRoomCode(null);
  }, []);

  // ── TEACHER SEND HELPER ──
  const teacherSend = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  if (!role) return <Lobby onJoin={handleJoin} urlRoom={getRoomFromURL()} />;
  if (role === 'teacher') return <TeacherView teacherRooms={teacherRooms} wsSend={teacherSend} />;
  if (state.phase === 'finished') return <DebriefScreen state={state} onRestart={handleRestart} />;
  if (state.phase === 'lobby') return (
    <div className="min-h-screen bg-[#0D1117] text-white flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-4">⏳</div>
        <h2 className="text-xl font-bold text-[#F0B429] mb-2">Waiting for Director</h2>
        <p className="text-sm text-[#8B949E]">The simulation will start when a Director creates this room.</p>
        <div className="mt-4 inline-flex items-center gap-2 bg-[#161B22] border border-[#30363D] rounded-lg px-4 py-2">
          <span className="text-[10px] text-[#8B949E] uppercase font-bold">Room</span>
          <span className="text-lg font-mono font-bold text-[#F0B429] tracking-wider">{roomCode}</span>
        </div>
        <p className="text-xs text-[#30363D] font-mono mt-3">{playerName} • {role}</p>
      </div>
    </div>
  );

  // ── STAGING PHASE: Director plans strategy, operators see briefing ──
  if (state.phase === 'staging') {
    const ops = Object.entries(state.operators || {});
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const getStage = (id) => { for (const [s, ids] of Object.entries(state.stageAssignments)) if (ids.includes(id)) return s; return null; };
    const unassigned = ops.filter(([id]) => !getStage(id));
    const allAssigned = ops.length > 0 && unassigned.length === 0;

    if (role === 'director') {
      return (
        <div className="min-h-screen bg-[#0D1117] text-white p-4">
          <div className="max-w-2xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-xl font-black text-[#F0B429] tracking-tight">STRATEGY PLANNING</h1>
                <p className="text-[10px] text-[#8B949E] mt-0.5">Assign your team and review the briefing before starting</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="bg-[#161B22] border border-[#F0B429]/30 rounded-lg px-3 py-1.5 text-center">
                  <p className="text-[8px] text-[#8B949E] uppercase font-bold">Room</p>
                  <p className="text-lg font-mono font-black text-[#F0B429] tracking-wider leading-tight">{roomCode}</p>
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(shareUrl); }}
                  className="text-[10px] text-[#58A6FF] hover:text-[#79C0FF] transition-colors cursor-pointer bg-[#161B22] border border-[#30363D] rounded-lg px-2 py-1"
                >
                  Copy link
                </button>
              </div>
            </div>

            {/* Worker Allocation Board */}
            <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-4 mb-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">Factory Blueprint — Worker Allocation</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[#8B949E]">{ops.length} operator{ops.length !== 1 ? 's' : ''}</span>
                  {allAssigned && <span className="text-[9px] font-bold text-[#3FB950] bg-[#3FB950]/10 px-1.5 py-0.5 rounded-full">All assigned</span>}
                </div>
              </div>

              {/* Stage columns */}
              <div className="grid grid-cols-5 gap-2 mb-3">
                {STAGES.map(s => {
                  const stageOps = ops.filter(([id]) => getStage(id) === s.id);
                  const count = stageOps.length;
                  return (
                    <div key={s.id} className={`bg-[#0D1117] border rounded-lg p-2 text-center transition-all ${count > 0 ? 'border-[#30363D]' : 'border-dashed border-[#21262D]'}`}>
                      <div className="text-lg leading-none mb-1">{s.icon}</div>
                      <div className="text-[9px] font-bold text-white">{s.shortName}</div>
                      <div className={`text-[8px] font-mono ${count >= s.maxOps ? 'text-[#F0B429]' : 'text-[#8B949E]'}`}>{count}/{s.maxOps}</div>
                      {stageOps.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          {stageOps.map(([id, op]) => (
                            <div key={id} className="text-[8px] bg-[#161B22] rounded px-1 py-0.5 truncate flex items-center gap-1">
                              <span>{op.isBot ? '🤖' : '👷'}</span>
                              <span className="text-[#C9D1D9] truncate">{op.name.length > 6 ? op.name.slice(0, 6) + '..' : op.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Unassigned operators */}
              {ops.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-sm text-[#8B949E] mb-2">Waiting for operators to join...</p>
                  <div className="flex justify-center gap-1 mb-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <button onClick={() => {
                    ['Bot-WH','Bot-ASM','Bot-OVN','Bot-QA','Bot-LOG'].forEach((name, i) => {
                      dispatch({ type: 'ADD_OPERATOR', id: genId(), name, stage: ['warehouse','assembly','oven','qa','logistics'][i], isBot: true });
                    });
                  }} className="py-2 px-4 text-xs font-bold bg-cyan/15 text-cyan border border-cyan/30 rounded-lg hover:bg-cyan/25 transition-all active:scale-[0.98] cursor-pointer">
                    Solo Mode — Add 5 Bot Operators
                  </button>
                </div>
              ) : unassigned.length > 0 ? (
                <div className="space-y-2">
                  {unassigned.map(([id, op]) => (
                    <div key={id} className="bg-[#F0B429]/5 border border-[#F0B429]/30 rounded-lg p-2.5">
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${op.isBot ? 'bg-cyan' : 'bg-[#3FB950]'}`} />
                        <span className="text-xs font-bold text-white">{op.name}</span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold ${op.isBot ? 'bg-cyan/15 text-cyan' : 'bg-[#3FB950]/15 text-[#3FB950]'}`}>
                          {op.isBot ? 'BOT' : 'HUMAN'}
                        </span>
                        <span className="text-[9px] text-[#F0B429] ml-auto">Assign →</span>
                      </div>
                      <div className="grid grid-cols-5 gap-1">
                        {STAGES.map(s => {
                          const count = state.stageAssignments[s.id].length;
                          const full = count >= s.maxOps;
                          return (
                            <button key={s.id} onClick={() => dispatch({ type: 'ASSIGN_OPERATOR', operatorId: id, fromStage: null, toStage: s.id })} disabled={full}
                              className={`py-1.5 px-1 rounded text-center transition-all cursor-pointer ${full
                                ? 'bg-[#21262D] text-[#30363D] cursor-not-allowed'
                                : 'bg-[#0D1117] text-[#8B949E] border border-[#30363D] hover:border-[#F0B429] hover:text-[#F0B429] active:scale-95'
                              }`}>
                              <div className="text-xs leading-none">{s.icon}</div>
                              <div className="text-[7px] font-bold mt-0.5">{s.shortName}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between bg-[#3FB950]/5 border border-[#3FB950]/20 rounded-lg px-3 py-2">
                  <span className="text-xs text-[#3FB950] font-medium">All operators assigned — ready to start!</span>
                  <button onClick={() => {
                    // Allow adding more bots to empty slots
                    const empty = STAGES.filter(s => state.stageAssignments[s.id].length === 0);
                    empty.forEach(s => dispatch({ type: 'ADD_OPERATOR', id: genId(), name: `Bot-${s.shortName}`, stage: s.id, isBot: true }));
                  }} className={`text-[9px] text-cyan/60 hover:text-cyan transition-colors cursor-pointer ${STAGES.every(s => state.stageAssignments[s.id].length > 0) ? 'hidden' : ''}`}>
                    + Fill empty with bots
                  </button>
                </div>
              )}
            </div>

            {/* Strategy Briefing (collapsible) */}
            <details className="mb-3 group">
              <summary className="bg-[#161B22] border border-[#30363D] rounded-xl px-4 py-3 cursor-pointer text-xs font-bold text-white uppercase tracking-wider flex items-center justify-between hover:border-[#F0B429]/30 transition-colors list-none">
                <span>Strategy Briefing</span>
                <span className="text-[#8B949E] text-[10px] font-normal normal-case group-open:hidden">Click to expand</span>
                <span className="text-[#8B949E] text-[10px] font-normal normal-case hidden group-open:inline">Click to collapse</span>
              </summary>
              <div className="mt-2">
                <StrategyBriefing />
              </div>
            </details>

            {/* Start Button */}
            <button
              onClick={() => dispatch({ type: 'START_SIMULATION' })}
              disabled={ops.length === 0}
              className={`w-full py-4 rounded-xl text-lg font-black tracking-wide transition-all cursor-pointer ${
                allAssigned
                  ? 'bg-[#3FB950] text-white hover:bg-[#4AE35B] active:scale-[0.98] shadow-lg shadow-[#3FB950]/20'
                  : ops.length > 0
                    ? 'bg-[#3FB950]/70 text-white/90 hover:bg-[#3FB950]/80 active:scale-[0.98]'
                    : 'bg-[#21262D] text-[#30363D] cursor-not-allowed'
              }`}
            >
              {ops.length === 0
                ? 'Waiting for operators...'
                : allAssigned
                  ? `Start Simulation (${ops.length} ready, ${state.maxStrategicChanges} changes)`
                  : `Start Simulation (${unassigned.length} unassigned)`
              }
            </button>
            {ops.length > 0 && !allAssigned && (
              <p className="text-[10px] text-[#F0B429] text-center mt-1.5">Assign all operators to stages before starting</p>
            )}
          </div>
        </div>
      );
    }

    // Operator/Observer staging — see briefing + their assignment
    const myStage = getStage(playerId);
    const myStageInfo = myStage ? STAGES.find(s => s.id === myStage) : null;
    return (
      <div className="min-h-screen bg-[#0D1117] text-white p-4">
        <div className="max-w-md mx-auto">
          {/* Header */}
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">🏭</div>
            <h2 className="text-xl font-bold text-[#F0B429] mb-1">You're In!</h2>
            <p className="text-sm text-[#8B949E]">Review the briefing while the Director plans the strategy</p>
            <div className="mt-2 inline-flex items-center gap-2 bg-[#161B22] border border-[#30363D] rounded-lg px-3 py-1.5">
              <span className="text-[9px] text-[#8B949E] uppercase font-bold">Room</span>
              <span className="text-base font-mono font-bold text-[#F0B429] tracking-wider">{roomCode}</span>
            </div>
          </div>

          {/* My Assignment */}
          {myStageInfo ? (
            <div className="bg-[#3FB950]/10 border border-[#3FB950]/30 rounded-xl p-4 mb-3 text-center">
              <p className="text-[10px] text-[#8B949E] uppercase font-bold mb-1">Your Assignment</p>
              <div className="text-3xl mb-1">{myStageInfo.icon}</div>
              <p className="text-lg font-bold text-white">{myStageInfo.name}</p>
            </div>
          ) : (
            <div className="bg-[#F0B429]/10 border border-[#F0B429]/30 rounded-xl p-4 mb-3 text-center">
              <p className="text-sm text-[#F0B429]">Waiting for Director to assign you to a stage...</p>
              <div className="flex justify-center gap-1 mt-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-[#F0B429] animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          {/* Team Overview */}
          <div className="bg-[#161B22] border border-[#30363D] rounded-xl p-3 mb-3">
            <h3 className="text-[10px] font-bold text-white uppercase tracking-wider mb-2">Team</h3>
            <div className="grid grid-cols-5 gap-1.5 mb-2">
              {STAGES.map(s => {
                const stageOps = ops.filter(([id]) => getStage(id) === s.id);
                return (
                  <div key={s.id} className="text-center">
                    <div className="text-sm">{s.icon}</div>
                    <div className="text-[8px] text-[#8B949E]">{s.shortName}</div>
                    <div className="text-[8px] font-mono text-[#8B949E]">{stageOps.length}/{s.maxOps}</div>
                  </div>
                );
              })}
            </div>
            <div className="space-y-1">
              {ops.map(([id, op]) => {
                const stage = getStage(id);
                const si = stage ? STAGES.find(s => s.id === stage) : null;
                return (
                  <div key={id} className={`flex items-center gap-2 text-[10px] px-2 py-1 rounded ${id === playerId ? 'bg-[#F0B429]/10 text-[#F0B429] font-bold' : 'text-[#C9D1D9]'}`}>
                    <span>{op.isBot ? '🤖' : '👷'}</span>
                    <span className="flex-1 truncate">{op.name}{id === playerId ? ' (you)' : ''}</span>
                    {si ? <span className="text-[#8B949E]">{si.icon} {si.shortName}</span> : <span className="text-[#30363D]">—</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Strategy Briefing */}
          <details className="mb-3 group" open>
            <summary className="bg-[#161B22] border border-[#30363D] rounded-xl px-4 py-3 cursor-pointer text-xs font-bold text-white uppercase tracking-wider flex items-center justify-between hover:border-[#F0B429]/30 transition-colors list-none">
              <span>Strategy Briefing</span>
              <span className="text-[#8B949E] text-[10px] font-normal normal-case group-open:hidden">Click to expand</span>
              <span className="text-[#8B949E] text-[10px] font-normal normal-case hidden group-open:inline">Click to collapse</span>
            </summary>
            <div className="mt-2">
              <StrategyBriefing />
            </div>
          </details>

          <div className="text-center text-xs text-[#30363D] font-mono">{playerName} • {role}</div>
        </div>
      </div>
    );
  }

  switch (role) {
    case 'director': return <DirectorView state={state} dispatch={dispatch} roomCode={roomCode} />;
    case 'operator': return <OperatorView state={state} dispatch={remoteDispatch} operatorId={playerId} operatorName={playerName} />;
    case 'observer': return <ObserverView state={state} />;
    default: return null;
  }
}
