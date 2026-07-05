const ROOM_ASSETS = {
  firstFloor: "assets/first-floor-transparent.png",
  secondFloor: "assets/second-floor.png",
};

const ITEM_MANIFEST_PATH = "assets/items/items.json?v=20260705-censored-annie-mattress-edgefix";
let ITEMS = [];

const PALETTE = {
  page: 0xfff0f5,
  dotStrong: 0xffd9ea,
  dotSoft: 0xfce7f3,
  title: 0xb4497a,
  text: 0x8a4468,
  muted: 0x9a5c78,
  accent: 0xc9548c,
  accentLight: 0xe9a0c4,
  panelShadow: 0xf3c9dd,
  card: 0xfdeef5,
  cardReady: 0xfff6fa,
  white: 0xffffff,
  green: 0x4caf7d,
};

const FONT = {
  display: "Baloo 2, Nunito, Arial",
  body: "Nunito, Arial",
  mono: "Consolas, monospace",
  script: "Marck Script, cursive",
};

const ROOM_IDS = {
  bedroom: "bedroom",
};

const ROOMS = {
  [ROOM_IDS.bedroom]: {
    id: ROOM_IDS.bedroom,
    label: "Спальня",
    asset: ROOM_ASSETS.firstFloor,
    ratio: 694 / 640,
    hasSecondFloor: true,
  },
};

const ROOM_ORDER = [ROOM_IDS.bedroom];
const SECOND_FLOOR_LAYOUT = {
  xOffset: 154,
  yOffset: 185,
  widthInset: 192,
  heightInset: 330,
};

const state = {
  activeRoomId: ROOM_IDS.bedroom,
  showSecondFloor: false,
  itemStatus: {},
  placed: [],
  camera: {
    x: 0,
    y: 0,
    zoom: 1,
  },
  modalItemId: null,
  modalScroll: 0,
  selectedPlacedId: null,
  panelScroll: 0,
};

let app;
let root;
let backgroundLayer;
let uiLayer;
let roomLayer;
let itemLayer;
let controlLayer;
let modalLayer;
let dragLayer;
let layout = null;
const placedTokenViews = new Map();
let secondFloorToken = null;
let activeDrag = null;
let dragGhost = null;
let backgroundDots = null;
let backgroundDebugLastSync = 0;
let ignoreStageTapOnce = false;
const activePointers = new Map();
let touchCameraGesture = null;

const BACKGROUND_DRIFT = {
  strongStep: 46,
  softStep: 30,
  xSpeed: 8,
  ySpeed: 8,
  direction: "down-right",
};

const backgroundDriftPosition = {
  x: 0,
  y: 0,
};

const PLACED_TRANSFORM = {
  minScale: 0.45,
  maxScale: 5.6,
  maxSkew: 0.8,
};

const CAMERA_LIMITS = {
  minZoom: 0.65,
  maxZoom: 2.2,
  maxPanFactor: 0.85,
  panOverscanFactor: 0.12,
};

const DESKTOP_LAYOUT_LIMITS = {
  panelMinWidth: 288,
  panelMaxWidth: 430,
  panelViewportFactor: 0.12,
  roomBaseMaxWidth: 640,
  roomMaxWidth: 1080,
  roomViewportFactor: 0.32,
};

const SCENE_LAYERS = {
  SECOND_FLOOR: 5,
  ITEM_DEFAULT: 6,
};

const STORAGE_KEY = "kassyaka-censored:room-state:v1";
const STORAGE_VERSION = 1;

function currentRoom() {
  return ROOMS[state.activeRoomId] || ROOMS[ROOM_IDS.bedroom];
}

function currentRoomPlaced() {
  return state.placed.filter((placed) => placed.roomId === currentRoom().id);
}

function roomSupportsSecondFloor() {
  return Boolean(currentRoom().hasSecondFloor);
}

function nextRoomId() {
  const index = ROOM_ORDER.indexOf(currentRoom().id);
  return ROOM_ORDER[(index + 1) % ROOM_ORDER.length];
}

let placedIdSequence = 0;

function makePlacedId(itemId) {
  placedIdSequence += 1;
  return `${Date.now().toString(36)}-${placedIdSequence.toString(36)}-${itemId}`;
}

function statusOf() {
  return "ready";
}

function availableItems() {
  return ITEMS;
}

async function loadItems() {
  const response = await fetch(ITEM_MANIFEST_PATH);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${ITEM_MANIFEST_PATH}`);
  }

  const manifest = await response.json();
  return manifest.items.map((item, index) => ({
    ...item,
    initial: item.name?.[0] || "?",
    hue: Math.round((index * 137.5) % 360),
  }));
}

function normalizeStoredPlaced(placed) {
  const itemId = placed?.id || placed?.itemId;
  const roomId = ROOMS[placed?.roomId]?.id;
  if (!placed || !ITEMS.some((item) => item.id === itemId) || !roomId) return null;
  return {
    placedId: placed.placedId || makePlacedId(itemId),
    id: itemId,
    roomId,
    x: clamp(Number(placed.x) || 50, 6, 94),
    y: clamp(Number(placed.y) || 50, 8, 94),
    scaleX: clamp(Number(placed.scaleX) || 1, PLACED_TRANSFORM.minScale, PLACED_TRANSFORM.maxScale),
    scaleY: clamp(Number(placed.scaleY) || 1, PLACED_TRANSFORM.minScale, PLACED_TRANSFORM.maxScale),
    rotation: Number.isFinite(Number(placed.rotation)) ? Number(placed.rotation) : 0,
    skewY: clamp(
      Number.isFinite(Number(placed.skewY)) ? Number(placed.skewY) : 0,
      -PLACED_TRANSFORM.maxSkew,
      PLACED_TRANSFORM.maxSkew,
    ),
    flippedX: Boolean(placed.flippedX),
    layerOffset: Number.isFinite(Number(placed.layerOffset))
      ? Number(placed.layerOffset)
      : 0,
  };
}

function defaultCamera() {
  return { x: 0, y: 0, zoom: 1 };
}

function normalizeStoredCamera(camera) {
  if (!camera) return defaultCamera();
  return {
    x: Number.isFinite(Number(camera.x)) ? Number(camera.x) : 0,
    y: Number.isFinite(Number(camera.y)) ? Number(camera.y) : 0,
    zoom: clamp(
      Number.isFinite(Number(camera.zoom)) ? Number(camera.zoom) : 1,
      CAMERA_LIMITS.minZoom,
      CAMERA_LIMITS.maxZoom,
    ),
  };
}

function loadSceneState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORAGE_VERSION) return null;
    return parsed;
  } catch (error) {
    console.warn("Не удалось загрузить сохранение комнаты.", error);
    return null;
  }
}

function applyStoredSceneState(saved) {
  if (!saved) return;
  const placed = Array.isArray(saved.placed)
    ? saved.placed.map(normalizeStoredPlaced).filter(Boolean)
    : [];

  state.activeRoomId = ROOMS[saved.activeRoomId]?.id || ROOM_IDS.bedroom;
  state.showSecondFloor = roomSupportsSecondFloor() && Boolean(saved.showSecondFloor);
  state.itemStatus = {};
  state.placed = placed;
  state.camera = normalizeStoredCamera(saved.camera);
  state.modalItemId = null;
  state.selectedPlacedId = null;
  state.panelScroll = 0;
  storageLastSavedAt = saved.updatedAt ? String(saved.updatedAt) : "";
  storageStatus = "loaded";
}

function sceneSnapshot() {
  return {
    version: STORAGE_VERSION,
    updatedAt: Date.now(),
    activeRoomId: state.activeRoomId,
    showSecondFloor: state.showSecondFloor,
    camera: state.camera,
    placed: state.placed,
  };
}

let storageLastSavedAt = "";
let storageStatus = "ready";
let renderQueued = false;
let sceneRenderQueued = false;
let roomStaticDirty = true;

function saveSceneState() {
  try {
    const snapshot = sceneSnapshot();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    storageLastSavedAt = String(snapshot.updatedAt);
    storageStatus = "saved";
  } catch (error) {
    storageStatus = "error";
    console.warn("Не удалось сохранить комнату.", error);
  }
}

function markSceneChanged() {
  saveSceneState();
  requestRender();
}

function markSceneChangedScene() {
  saveSceneState();
  requestSceneRender();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hslToHex(h, s = 64, l = 78) {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
}

function destroySceneChild(child) {
  if (!child || child.destroyed || typeof child.destroy !== "function") return;
  if (child.children?.length) {
    for (const nested of child.removeChildren()) {
      destroySceneChild(nested);
    }
  }
  if (child instanceof PIXI.Sprite && !(child instanceof PIXI.Text)) {
    child.destroy({ children: false, texture: false, textureSource: false });
    return;
  }
  child.destroy({ children: false });
}

function clear(container) {
  for (const child of container.removeChildren()) {
    destroySceneChild(child);
  }
}

function fitItemSize(item, maxWidth, maxHeight) {
  const sourceWidth = item.size?.width || 1;
  const sourceHeight = item.size?.height || 1;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: sourceWidth * scale,
    height: sourceHeight * scale,
    scale,
  };
}

function getItemBaseBounds(item) {
  const display = fitItemSize(
    item,
    item.roomMaxWidth || 92,
    item.roomMaxHeight || 92,
  );
  return {
    left: display.width / 2,
    right: display.width / 2,
    top: display.height / 2,
    bottom: display.height / 2,
    width: display.width,
    height: display.height,
  };
}

function makeItemSprite(item, maxWidth, maxHeight) {
  const sprite = new PIXI.Sprite(PIXI.Texture.from(item.asset));
  const sourceWidth = item.size?.width || sprite.texture.width || 1;
  const sourceHeight = item.size?.height || sprite.texture.height || 1;
  const display = fitItemSize(
    { size: { width: sourceWidth, height: sourceHeight } },
    maxWidth,
    maxHeight,
  );
  sprite.anchor.set(0.5);
  sprite.width = display.width;
  sprite.height = display.height;
  return sprite;
}

function makeText(text, options) {
  return new PIXI.Text({
    text,
    style: {
      fontFamily: options.fontFamily || FONT.body,
      fontSize: options.fontSize,
      fontWeight: options.fontWeight || "600",
      fill: options.fill,
      align: options.align || "left",
      wordWrap: Boolean(options.wordWrapWidth),
      wordWrapWidth: options.wordWrapWidth || 0,
      lineHeight: options.lineHeight,
      dropShadow: options.dropShadow,
    },
  });
}

function drawRoundedBox(
  graphics,
  x,
  y,
  width,
  height,
  radius,
  fill,
  stroke = null,
) {
  graphics.roundRect(x, y, width, height, radius);
  graphics.fill(fill);
  if (stroke) {
    graphics.stroke(stroke);
  }
}

function drawDashedRoundedBox(
  graphics,
  x,
  y,
  width,
  height,
  radius,
  color,
  alpha = 1,
  dash = 7,
  gap = 5,
) {
  graphics.clear();
  graphics.roundRect(x, y, width, height, radius);
  graphics.fill({ color: PALETTE.cardReady, alpha: 1 });

  const left = x + radius;
  const right = x + width - radius;
  const top = y;
  const bottom = y + height;
  const drawDashedLine = (x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    for (let offset = 0; offset < length; offset += dash + gap) {
      const end = Math.min(offset + dash, length);
      graphics.moveTo(x1 + ux * offset, y1 + uy * offset);
      graphics.lineTo(x1 + ux * end, y1 + uy * end);
    }
  };

  drawDashedLine(left, top, right, top);
  drawDashedLine(x + width, y + radius, x + width, y + height - radius);
  drawDashedLine(right, bottom, left, bottom);
  drawDashedLine(x, y + height - radius, x, y + radius);
  graphics.stroke({ width: 2, color, alpha });
}

function addShadow(
  container,
  x,
  y,
  width,
  height,
  radius,
  color = PALETTE.panelShadow,
  offset = 6,
) {
  const shadow = new PIXI.Graphics();
  drawRoundedBox(shadow, x, y + offset, width, height, radius, {
    color,
    alpha: 1,
  });
  container.addChild(shadow);
  return shadow;
}

function makeButton(label, x, y, width, height, onClick, options = {}) {
  const button = new PIXI.Container();
  button.x = x;
  button.y = y;
  button.eventMode = "static";
  button.cursor = "pointer";

  const bg = new PIXI.Graphics();
  drawRoundedBox(bg, 0, 0, width, height, height / 2, {
    color: options.fill || PALETTE.white,
    alpha: 1,
  });
  button.addChild(bg);

  const text = makeText(label, {
    fontFamily: FONT.display,
    fontSize: options.fontSize || 15,
    fontWeight: "700",
    fill: options.textColor || PALETTE.accent,
  });
  text.anchor.set(0.5);
  text.x = width / 2;
  text.y = height / 2 + 1;
  button.addChild(text);

  button.on("pointertap", onClick);
  button.on("pointerover", () => {
    bg.tint = 0xfff6fa;
  });
  button.on("pointerout", () => {
    bg.tint = 0xffffff;
  });

  return button;
}

function makeSticker(item, size = 44) {
  const sticker = new PIXI.Container();
  if (item.asset) {
    const sprite = makeItemSprite(item, size, size);
    sprite.x = size / 2;
    sprite.y = size / 2;
    sticker.addChild(sprite);
    return sticker;
  }

  const bg = new PIXI.Graphics();
  const fill = hslToHex(item.hue);
  const textColor = hslToHex(item.hue, 64, 31);
  drawRoundedBox(bg, 0, 0, size, size, Math.round(size * 0.3), {
    color: fill,
    alpha: 1,
  });
  bg.rect(0, size - Math.max(3, size * 0.08), size, Math.max(3, size * 0.08));
  bg.fill({ color: 0x000000, alpha: 0.06 });
  sticker.addChild(bg);

  const initial = makeText(item.initial, {
    fontFamily: FONT.display,
    fontSize: Math.round(size * 0.42),
    fontWeight: "800",
    fill: textColor,
  });
  initial.anchor.set(0.5);
  initial.x = size / 2;
  initial.y = size / 2 + 1;
  sticker.addChild(initial);
  return sticker;
}

function makePlacedToken(item, scale = 1) {
  const token = new PIXI.Container();
  if (item.asset) {
    const bounds = getItemBaseBounds(item);
    const sprite = makeItemSprite(item, bounds.width * scale, bounds.height * scale);
    token.addChild(sprite);
  } else {
    const sticker = makeSticker(item, 44 * scale);
    sticker.x = -22 * scale;
    sticker.y = -22 * scale;
    token.addChild(sticker);
  }

  return token;
}

function makeQuestionButton(x, y, onClick) {
  const button = new PIXI.Container();
  button.x = x;
  button.y = y;
  button.eventMode = "static";
  button.cursor = "pointer";
  button.hitArea = new PIXI.Circle(0, 0, 13);

  const bg = new PIXI.Graphics();
  bg.circle(0, 0, 12);
  bg.fill({ color: PALETTE.white, alpha: 1 });
  bg.stroke({ width: 2, color: PALETTE.accentLight, alpha: 1 });
  button.addChild(bg);

  const icon = makeText("?", {
    fontFamily: FONT.display,
    fontSize: 17,
    fontWeight: "800",
    fill: PALETTE.accent,
    align: "center",
  });
  icon.anchor.set(0.5);
  icon.x = 0;
  icon.y = 1;
  button.addChild(icon);

  button.on("pointerdown", (event) => {
    event.stopPropagation();
  });
  button.on("pointertap", (event) => {
    event.stopPropagation();
    onClick();
  });

  return button;
}

function makeTransformHandle(type, x, y, onPointerDown, scale = 1) {
  const visualScale = clamp(scale, 0.58, 1);
  const strokeWidth = Math.max(1.5, 2 * visualScale);
  const cornerRadius = 5 * visualScale;
  const circleRadius = (type === "delete" ? 11 : 10) * visualScale;
  const hitRadius = Math.max(13, circleRadius + 4);
  const handle = new PIXI.Container();
  handle.x = x;
  handle.y = y;
  handle.eventMode = "static";
  handle.cursor =
    type === "horizontal"
      ? "ew-resize"
      : type === "vertical"
        ? "ns-resize"
        : type === "rotate"
          ? "grab"
          : type === "delete" ||
              type === "info" ||
              type === "flip" ||
              type === "layer-up" ||
              type === "layer-down"
            ? "pointer"
            : "nwse-resize";

  const bg = new PIXI.Graphics();
  if (type === "horizontal") {
    bg.roundRect(-5 * visualScale, -13 * visualScale, 10 * visualScale, 26 * visualScale, cornerRadius);
    handle.hitArea = new PIXI.Rectangle(-hitRadius / 2, -hitRadius, hitRadius, hitRadius * 2);
  } else if (type === "vertical") {
    bg.roundRect(-13 * visualScale, -5 * visualScale, 26 * visualScale, 10 * visualScale, cornerRadius);
    handle.hitArea = new PIXI.Rectangle(-hitRadius, -hitRadius / 2, hitRadius * 2, hitRadius);
  } else if (type === "corner") {
    bg.roundRect(-8 * visualScale, -8 * visualScale, 16 * visualScale, 16 * visualScale, cornerRadius);
    handle.hitArea = new PIXI.Rectangle(-hitRadius, -hitRadius, hitRadius * 2, hitRadius * 2);
  } else {
    bg.circle(0, 0, circleRadius);
    handle.hitArea = new PIXI.Circle(0, 0, hitRadius);
  }

  const fill = type === "delete" ? 0xf59ab5 : PALETTE.white;
  const stroke = type === "delete" ? 0xd95082 : PALETTE.accent;
  bg.fill({ color: fill, alpha: 1 });
  bg.stroke({ width: strokeWidth, color: stroke, alpha: 1 });
  handle.addChild(bg);

  if (
    type === "rotate" ||
    type === "delete" ||
    type === "info" ||
    type === "flip" ||
    type === "layer-up" ||
    type === "layer-down"
  ) {
    const icons = {
      delete: "×",
      info: "?",
      rotate: "↻",
      flip: "⇋",
      "layer-up": "↑",
      "layer-down": "↓",
    };
    const icon = makeText(icons[type], {
      fontFamily: FONT.display,
      fontSize: (type === "delete" ? 16 : 15) * visualScale,
      fontWeight: "800",
      fill: type === "delete" ? PALETTE.white : PALETTE.accent,
      align: "center",
    });
    icon.anchor.set(0.5);
    icon.y = type === "delete" ? 0 : visualScale;
    handle.addChild(icon);
  }

  handle.on("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    ignoreStageTapOnce = true;
    onPointerDown(event);
  });
  handle.on("pointertap", (event) => {
    event.stopPropagation();
  });

  return handle;
}

function placedScreenPosition(placed) {
  const room = layout.room;
  return {
    x: room.x + (placed.x / 100) * room.width,
    y: room.y + (placed.y / 100) * room.height,
  };
}

function localTransformPoint(point, center, rotation) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: dx * cos + dy * sin,
    y: -dx * sin + dy * cos,
  };
}

function skewSelectionPoint(x, y, skewY) {
  return {
    x: x * Math.cos(skewY),
    y: y + x * Math.sin(skewY),
  };
}

function clampCamera() {
  state.camera.zoom = clamp(
    state.camera.zoom || 1,
    CAMERA_LIMITS.minZoom,
    CAMERA_LIMITS.maxZoom,
  );
  if (!layout?.room) return;
  const bounds = cameraPanBounds();
  state.camera.x = clamp(state.camera.x || 0, bounds.minX, bounds.maxX);
  state.camera.y = clamp(state.camera.y || 0, bounds.minY, bounds.maxY);
}

function cameraPanBounds() {
  const zoom = state.camera.zoom || 1;
  const room = layout.room;
  const viewportLeft = layout.desktop ? layout.margin : 0;
  const viewportRight = layout.desktop && layout.panel
    ? layout.panel.x - 18
    : layout.width;
  const viewportTop = room.y;
  const viewportBottom = layout.desktop
    ? layout.height - layout.margin
    : layout.panel?.y || layout.height;
  const roomLeft = room.x * zoom;
  const roomRight = (room.x + room.width) * zoom;
  const roomTop = room.y * zoom;
  const roomBottom = (room.y + room.height) * zoom;
  const fitMinX = viewportRight - roomRight;
  const fitMaxX = viewportLeft - roomLeft;
  const fitMinY = viewportBottom - roomBottom;
  const fitMaxY = viewportTop - roomTop;
  const fallbackX = room.width * CAMERA_LIMITS.maxPanFactor * zoom;
  const fallbackY = room.height * CAMERA_LIMITS.maxPanFactor * zoom;
  const overscanX = Math.min(
    layout.width * CAMERA_LIMITS.panOverscanFactor,
    room.width * zoom * CAMERA_LIMITS.maxPanFactor,
  );
  const overscanY = Math.min(
    layout.height * CAMERA_LIMITS.panOverscanFactor,
    room.height * zoom * CAMERA_LIMITS.maxPanFactor,
  );

  return {
    minX: Math.min(fitMinX, fitMaxX, -fallbackX) - overscanX,
    maxX: Math.max(fitMinX, fitMaxX, fallbackX) + overscanX,
    minY: Math.min(fitMinY, fitMaxY, -fallbackY) - overscanY,
    maxY: Math.max(fitMinY, fitMaxY, fallbackY) + overscanY,
  };
}

function applyCameraTransform() {
  clampCamera();
  for (const layer of [roomLayer, itemLayer]) {
    if (!layer) continue;
    layer.x = state.camera.x;
    layer.y = state.camera.y;
    layer.scale.set(state.camera.zoom);
  }
}

function screenToScenePoint(point) {
  return {
    x: (point.x - state.camera.x) / state.camera.zoom,
    y: (point.y - state.camera.y) / state.camera.zoom,
  };
}

function sceneToScreenPoint(point) {
  return {
    x: point.x * state.camera.zoom + state.camera.x,
    y: point.y * state.camera.zoom + state.camera.y,
  };
}

function zoomCameraAt(point, factor) {
  const before = screenToScenePoint(point);
  state.camera.zoom = clamp(
    state.camera.zoom * factor,
    CAMERA_LIMITS.minZoom,
    CAMERA_LIMITS.maxZoom,
  );
  state.camera.x = point.x - before.x * state.camera.zoom;
  state.camera.y = point.y - before.y * state.camera.zoom;
  clampCamera();
  markSceneChangedScene();
}

function panCameraBy(dx, dy) {
  state.camera.x += dx;
  state.camera.y += dy;
  clampCamera();
  requestSceneRender();
}

function startCameraPan(event) {
  const point = eventPoint(event);
  activeDrag = {
    type: "camera-pan",
    startX: point.x,
    startY: point.y,
    startCameraX: state.camera.x,
    startCameraY: state.camera.y,
  };
}

function startTransformDrag(event, placed, item, mode) {
  const center = placedScreenPosition(placed);
  const point = screenToScenePoint({ x: event.global.x, y: event.global.y });
  const rotation = placed.rotation || 0;
  activeDrag = {
    type: "transform",
    placedId: placed.placedId,
    mode,
    center,
    startAngle: Math.atan2(point.y - center.y, point.x - center.x),
    startRotation: rotation,
    startScaleX: placed.scaleX || 1,
    startScaleY: placed.scaleY || 1,
    startSkewY: placed.skewY || 0,
    baseScale: layout.desktop ? 1 : 0.9,
    bounds: getItemBaseBounds(item),
  };
}

function removePlacedItem(placedId) {
  state.placed = state.placed.filter((placed) => placed.placedId !== placedId);
  if (state.selectedPlacedId === placedId) {
    state.selectedPlacedId = null;
  }
  markSceneChanged();
}

function placedLayerZ(placed) {
  return SCENE_LAYERS.ITEM_DEFAULT + (placed.layerOffset || 0);
}

function flipPlacedItem(placedId) {
  const placed = state.placed.find((candidate) => candidate.placedId === placedId);
  if (!placed) return;
  placed.flippedX = !placed.flippedX;
  markSceneChangedScene();
}

function movePlacedLayer(placedId, direction) {
  const placed = state.placed.find((candidate) => candidate.placedId === placedId);
  if (!placed) return;
  let nextLayer = placedLayerZ(placed) + direction;
  if (nextLayer === SCENE_LAYERS.SECOND_FLOOR) {
    nextLayer += direction;
  }
  placed.layerOffset = nextLayer - SCENE_LAYERS.ITEM_DEFAULT;
  markSceneChangedScene();
}

function drawSelectionControls(placed, item, zIndex) {
  const position = sceneToScreenPoint(placedScreenPosition(placed));
  const baseScale = layout.desktop ? 1 : 0.9;
  const cameraZoom = state.camera.zoom || 1;
  const screenScale = baseScale * cameraZoom;
  const scaleX = Math.abs(placed.scaleX || 1);
  const scaleY = Math.abs(placed.scaleY || 1);
  const bounds = getItemBaseBounds(item);
  const left = bounds.left * screenScale * scaleX;
  const right = bounds.right * screenScale * scaleX;
  const top = bounds.top * screenScale * scaleY;
  const bottom = bounds.bottom * screenScale * scaleY;
  const controlScale = clamp(Math.max(left + right, top + bottom) / 96, 0.58, 1);
  const rotateGap = 26 * controlScale;
  const sideGap = Math.max(18, 28 * controlScale);
  const sideStep = Math.max(22, 28 * controlScale);
  const selectionSkew = placed.skewY || 0;
  const horizontalHandlePosition = skewSelectionPoint(right, 0, selectionSkew);
  const verticalHandlePosition = skewSelectionPoint(0, bottom, selectionSkew);
  const cornerHandlePosition = skewSelectionPoint(right, bottom, selectionSkew);
  const infoHandlePosition = skewSelectionPoint(right, -top, selectionSkew);
  const flipHandlePosition = skewSelectionPoint(-left, bottom, selectionSkew);
  const layerUpHandlePosition = skewSelectionPoint(right + sideGap, -top + sideStep, selectionSkew);
  const layerDownHandlePosition = skewSelectionPoint(right + sideGap, -top + sideStep * 2, selectionSkew);
  const deleteHandlePosition = skewSelectionPoint(-left, -top, selectionSkew);
  const controls = new PIXI.Container();
  controls.x = Math.round(position.x);
  controls.y = Math.round(position.y);
  controls.rotation = placed.rotation || 0;
  controls.zIndex = zIndex + 5000;

  const outline = new PIXI.Graphics();
  outline.skew.y = selectionSkew;
  outline.roundRect(
    -left,
    -top,
    left + right,
    top + bottom,
    12,
  );
  outline.stroke({ width: Math.max(1.5, 3 * controlScale), color: PALETTE.accent, alpha: 0.9 });
  controls.addChild(outline);

  const rotateLine = new PIXI.Graphics();
  rotateLine.moveTo(0, -top);
  rotateLine.lineTo(0, -top - rotateGap);
  rotateLine.stroke({ width: Math.max(1.25, 2 * controlScale), color: PALETTE.accent, alpha: 0.8 });
  controls.addChild(rotateLine);

  controls.addChild(
    makeTransformHandle("horizontal", horizontalHandlePosition.x, horizontalHandlePosition.y, (event) =>
      startTransformDrag(event, placed, item, "horizontal"),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("vertical", verticalHandlePosition.x, verticalHandlePosition.y, (event) =>
      startTransformDrag(event, placed, item, "vertical"),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("corner", cornerHandlePosition.x, cornerHandlePosition.y, (event) =>
      startTransformDrag(event, placed, item, "corner"),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("rotate", 0, -top - rotateGap, (event) =>
      startTransformDrag(event, placed, item, "rotate"),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("info", infoHandlePosition.x, infoHandlePosition.y, () => {
      state.modalItemId = placed.id;
      state.modalScroll = 0;
      requestRender();
    }, controlScale),
  );
  controls.addChild(
    makeTransformHandle("flip", flipHandlePosition.x, flipHandlePosition.y, () =>
      flipPlacedItem(placed.placedId),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("layer-up", layerUpHandlePosition.x, layerUpHandlePosition.y, () =>
      movePlacedLayer(placed.placedId, 1),
      controlScale,
    ),
  );
  controls.addChild(
    makeTransformHandle("layer-down", layerDownHandlePosition.x, layerDownHandlePosition.y, () =>
      movePlacedLayer(placed.placedId, -1),
      controlScale,
    ),
  );

  const deleteHandle = makeTransformHandle("delete", deleteHandlePosition.x, deleteHandlePosition.y, () =>
    removePlacedItem(placed.placedId),
    controlScale,
  );
  deleteHandle.cursor = "pointer";
  controls.addChild(deleteHandle);

  controlLayer.addChild(controls);
}

function computeLayout(width) {
  const desktop = width >= 980;
  const roomRatio = currentRoom().ratio;
  const margin = desktop ? 28 : 14;
  const headerTop = desktop ? 22 : 18;
  const titleSize = desktop ? 32 : 28;
  const topbarHeight = desktop ? 142 : 126;
  const mainTop = headerTop + topbarHeight + (desktop ? 18 : 14);

  if (desktop) {
    const panelWidth = Math.round(clamp(
      width * DESKTOP_LAYOUT_LIMITS.panelViewportFactor,
      DESKTOP_LAYOUT_LIMITS.panelMinWidth,
      DESKTOP_LAYOUT_LIMITS.panelMaxWidth,
    ));
    const gap = 18;
    const panelX = width - margin - panelWidth;
    const availableMainHeight = Math.max(
      320,
      window.innerHeight - mainTop - margin - 12,
    );
    const widthBoundRoomWidth = panelX - margin - gap;
    const heightBoundRoomWidth = availableMainHeight / roomRatio;
    const responsiveRoomMaxWidth = clamp(
      width * DESKTOP_LAYOUT_LIMITS.roomViewportFactor,
      DESKTOP_LAYOUT_LIMITS.roomBaseMaxWidth,
      DESKTOP_LAYOUT_LIMITS.roomMaxWidth,
    );
    const maxRoomWidth = Math.min(responsiveRoomMaxWidth, widthBoundRoomWidth, heightBoundRoomWidth);
    const roomWidth = Math.max(320, maxRoomWidth);
    const roomHeight = roomWidth * roomRatio;
    const roomAreaWidth = panelX - gap - margin;
    const groupX = margin + Math.max(0, (roomAreaWidth - roomWidth) / 2);
    const panelHeight = Math.min(694, availableMainHeight);
    const contentHeight = Math.ceil(
      mainTop + Math.max(roomHeight, panelHeight) + margin + 12,
    );
    const switchWidth = 174;
    const switchBox = {
      x: width - margin - switchWidth,
      y: headerTop + 2,
      width: switchWidth,
      height: 44,
    };

    return {
      desktop,
      width,
      height: Math.max(window.innerHeight, contentHeight),
      margin,
      title: {
        x: margin,
        y: headerTop,
        width: Math.max(280, switchBox.x - margin - 20),
        size: titleSize,
      },
      switchBox,
      room: { x: groupX, y: mainTop, width: roomWidth, height: roomHeight },
      panel: {
        x: width - margin - panelWidth,
        y: mainTop,
        width: panelWidth,
        height: availableMainHeight,
      },
    };
  }

  const mobilePanelHeight = 126;
  const mobileGap = 14;
  const bottomPanelY = Math.max(mainTop + 160, window.innerHeight - mobilePanelHeight);
  const availableRoomHeight = Math.max(220, bottomPanelY - (mainTop + 68) - mobileGap);
  const roomWidth = Math.min(
    640,
    width - margin * 2,
    availableRoomHeight / roomRatio,
  );
  const roomHeight = roomWidth * roomRatio;
  const roomX = (width - roomWidth) / 2;
  const contentHeight = window.innerHeight;

  return {
    desktop,
    width,
    height: Math.max(window.innerHeight, contentHeight),
    margin,
    title: {
      x: margin,
      y: headerTop,
      width: width - margin * 2,
      size: titleSize,
    },
    switchBox: { x: margin, y: mainTop, width: roomWidth, height: 54 },
    room: { x: roomX, y: mainTop + 68, width: roomWidth, height: roomHeight },
    panel: {
      x: 0,
      y: window.innerHeight - mobilePanelHeight,
      width,
      height: mobilePanelHeight,
      horizontal: true,
    },
  };
}

function resizeRenderer() {
  const next = computeLayout(window.innerWidth);
  app.renderer.resize(next.width, next.height);
  app.canvas.style.width = `${next.width}px`;
  app.canvas.style.height = `${next.height}px`;
  layout = next;
  roomStaticDirty = true;
  app.stage.hitArea = new PIXI.Rectangle(0, 0, layout.width, layout.height);
  renderAll();
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function drawDotField(width, height, step, radius, color, alpha, inset = 0) {
  const dots = new PIXI.Graphics();
  for (let y = inset; y <= height + step * 2; y += step) {
    for (let x = inset; x <= width + step * 2; x += step) {
      dots.circle(x, y, radius);
      dots.fill({ color, alpha });
    }
  }
  return dots;
}

function getBackgroundDebugState() {
  return {
    drifting: true,
    direction: BACKGROUND_DRIFT.direction,
    tickerStarted: Boolean(app?.ticker?.started),
    position: {
      x: Number(backgroundDriftPosition.x.toFixed(2)),
      y: Number(backgroundDriftPosition.y.toFixed(2)),
    },
    strongOffset: backgroundDots
      ? {
          x: Number(backgroundDots.strong.x.toFixed(2)),
          y: Number(backgroundDots.strong.y.toFixed(2)),
        }
      : null,
    softOffset: backgroundDots
      ? {
          x: Number(backgroundDots.soft.x.toFixed(2)),
          y: Number(backgroundDots.soft.y.toFixed(2)),
        }
      : null,
  };
}

function applyBackgroundDrift() {
  if (!backgroundDots) return;

  const strongX = modulo(
    backgroundDriftPosition.x,
    BACKGROUND_DRIFT.strongStep,
  );
  const strongY = modulo(
    backgroundDriftPosition.y,
    BACKGROUND_DRIFT.strongStep,
  );
  const softX = modulo(backgroundDriftPosition.x, BACKGROUND_DRIFT.softStep);
  const softY = modulo(backgroundDriftPosition.y, BACKGROUND_DRIFT.softStep);

  backgroundDots.strong.x = -BACKGROUND_DRIFT.strongStep + strongX;
  backgroundDots.strong.y = -BACKGROUND_DRIFT.strongStep + strongY;
  backgroundDots.soft.x = -BACKGROUND_DRIFT.softStep + softX;
  backgroundDots.soft.y = -BACKGROUND_DRIFT.softStep + softY;

  if (window.__kassyakaPixiDebug) {
    window.__kassyakaPixiDebug.background = getBackgroundDebugState();
  }
}

function updateBackgroundDrift(ticker) {
  const deltaSeconds = Math.min((ticker.deltaMS || 16.67) / 1000, 0.05);
  backgroundDriftPosition.x += BACKGROUND_DRIFT.xSpeed * deltaSeconds;
  backgroundDriftPosition.y += BACKGROUND_DRIFT.ySpeed * deltaSeconds;
  applyBackgroundDrift();

  const now = performance.now();
  if (now - backgroundDebugLastSync > 250) {
    backgroundDebugLastSync = now;
    syncBackgroundDebugDataset();
  }
}

function drawBackground() {
  clear(backgroundLayer);

  const page = new PIXI.Graphics();
  page.rect(0, 0, layout.width, layout.height);
  page.fill(PALETTE.page);
  backgroundLayer.addChild(page);

  backgroundDots = {
    strong: drawDotField(
      layout.width,
      layout.height,
      BACKGROUND_DRIFT.strongStep,
      3,
      PALETTE.dotStrong,
      1,
    ),
    soft: drawDotField(
      layout.width,
      layout.height,
      BACKGROUND_DRIFT.softStep,
      2,
      PALETTE.dotSoft,
      1,
      15,
    ),
  };

  backgroundLayer.addChild(backgroundDots.strong, backgroundDots.soft);
  applyBackgroundDrift();
}

function drawHeader() {
  const titleFontSize = layout.desktop
    ? Math.round(layout.title.size * 1.5)
    : 30;
  const title = makeText("С днём рождения, Касси!", {
    fontFamily: FONT.script,
    fontSize: titleFontSize,
    fontWeight: "400",
    fill: PALETTE.title,
    dropShadow: { color: 0xffffff, blur: 0, distance: 2, alpha: 1 },
  });
  title.x = layout.title.x + layout.title.width / 2;
  title.y = layout.title.y;
  title.anchor.set(0.5, 0);
  uiLayer.addChild(title);

  const subtitle = makeText(
    "Нажми на предмет — прочитай поздравление, а потом перетащи\nего в комнату ✨",
    {
      fontFamily: FONT.body,
      fontSize: layout.desktop ? 14 : 13,
      fontWeight: "700",
      fill: PALETTE.muted,
      align: "center",
      lineHeight: layout.desktop ? 18 : 17,
      wordWrapWidth: layout.title.width - 12,
    },
  );
  subtitle.x = title.x;
  subtitle.y = title.y + title.height + (layout.desktop ? 26 : 20);
  subtitle.anchor.set(0.5, 0);
  uiLayer.addChild(subtitle);

}

function drawSwitch() {
  const box = layout.switchBox;
  const enabled = roomSupportsSecondFloor();
  addShadow(
    uiLayer,
    box.x,
    box.y,
    box.width,
    box.height,
    18,
    PALETTE.panelShadow,
    3,
  );
  const control = new PIXI.Container();
  control.x = box.x;
  control.y = box.y;
  control.eventMode = enabled ? "static" : "none";
  control.cursor = enabled ? "pointer" : "default";
  control.alpha = enabled ? 1 : 0.55;
  control.hitArea = new PIXI.Rectangle(0, 0, box.width, box.height);

  const bg = new PIXI.Graphics();
  drawRoundedBox(bg, 0, 0, box.width, box.height, 18, {
    color: PALETTE.white,
    alpha: 1,
  });
  control.addChild(bg);

  const checkbox = new PIXI.Graphics();
  drawRoundedBox(
    checkbox,
    13,
    box.height / 2 - 9,
    18,
    18,
    4,
    { color: enabled && state.showSecondFloor ? PALETTE.accent : 0xffffff, alpha: 1 },
    { width: 2, color: enabled ? PALETTE.accent : PALETTE.muted, alpha: 1 },
  );
  if (enabled && state.showSecondFloor) {
    checkbox.moveTo(17, box.height / 2);
    checkbox.lineTo(22, box.height / 2 + 5);
    checkbox.lineTo(29, box.height / 2 - 6);
    checkbox.stroke({ width: 2.5, color: 0xffffff, alpha: 1 });
  }
  control.addChild(checkbox);

  const label = makeText(enabled ? "Показывать\nвторой этаж" : "Второй этаж\nнедоступен", {
    fontFamily: FONT.display,
    fontSize: layout.desktop ? 13 : 16,
    fontWeight: "700",
    fill: PALETTE.title,
    lineHeight: layout.desktop ? 14 : 17,
  });
  label.x = 40;
  label.y = layout.desktop ? box.height / 2 - 15 : box.height / 2 - 18;
  control.addChild(label);

  control.on("pointertap", () => {
    if (!enabled) return;
    state.showSecondFloor = !state.showSecondFloor;
    markSceneChanged();
  });
  uiLayer.addChild(control);
}

function drawRoomBase() {
  clear(roomLayer);
  const room = layout.room;
  const roomSprite = new PIXI.Sprite(PIXI.Texture.from(currentRoom().asset));
  roomSprite.x = room.x;
  roomSprite.y = room.y;
  roomSprite.width = room.width;
  roomSprite.height = room.height;
  roomLayer.addChild(roomSprite);
  roomStaticDirty = false;
}

function syncSecondFloor() {
  if (!roomSupportsSecondFloor()) {
    if (secondFloorToken) secondFloorToken.visible = false;
    delete layout.secondFloor;
    return;
  }
  const room = layout.room;
  if (!secondFloorToken) {
    secondFloorToken = new PIXI.Sprite(PIXI.Texture.from(ROOM_ASSETS.secondFloor));
    secondFloorToken.zIndex = SCENE_LAYERS.SECOND_FLOOR;
    secondFloorToken.eventMode = "none";
    secondFloorToken.interactiveChildren = false;
  }

  secondFloorToken.x = room.x + SECOND_FLOOR_LAYOUT.xOffset;
  secondFloorToken.y = room.y + SECOND_FLOOR_LAYOUT.yOffset;
  secondFloorToken.width = room.width - SECOND_FLOOR_LAYOUT.widthInset;
  secondFloorToken.height = room.height - SECOND_FLOOR_LAYOUT.heightInset;
  secondFloorToken.visible = state.showSecondFloor;
  if (!secondFloorToken.parent) {
    itemLayer.addChild(secondFloorToken);
  }

  if (state.showSecondFloor) {
    layout.secondFloor = {
      x: secondFloorToken.x,
      y: secondFloorToken.y,
      width: secondFloorToken.width,
      height: secondFloorToken.height,
      xOffset: secondFloorToken.x - room.x,
      yOffset: secondFloorToken.y - room.y,
      layer: SCENE_LAYERS.SECOND_FLOOR,
    };
  } else {
    delete layout.secondFloor;
  }
}

function createPlacedTokenView(placed, item) {
  const token = makePlacedToken(item, 1);
  token.eventMode = "static";
  token.cursor = "grab";
  token.itemId = item.id;
  const bounds = getItemBaseBounds(item);
  token.hitArea = new PIXI.Rectangle(
    -bounds.left,
    -bounds.top,
    bounds.left + bounds.right,
    bounds.top + bounds.bottom,
  );

  token.on("pointerdown", (event) => {
    if (event.button !== 0) return;
    const livePlaced = state.placed.find((candidate) => candidate.placedId === placed.placedId);
    if (!livePlaced) return;
    const position = placedScreenPosition(livePlaced);
    event.stopPropagation();
    ignoreStageTapOnce = true;
    state.selectedPlacedId = livePlaced.placedId;
    const pointer = screenToScenePoint({ x: event.global.x, y: event.global.y });
    activeDrag = {
      type: "placed",
      placedId: livePlaced.placedId,
      offsetX: pointer.x - position.x,
      offsetY: pointer.y - position.y,
    };
    requestSceneRender();
  });
  token.on("pointertap", (event) => {
    event.stopPropagation();
    state.selectedPlacedId = placed.placedId;
    requestSceneRender();
  });

  return { placedId: placed.placedId, itemId: item.id, token };
}

function updatePlacedTokenView(view, placed, item) {
  const baseScale = layout.desktop ? 1 : 0.9;
  const position = placedScreenPosition(placed);
  const token = view.token;
  token.x = position.x;
  token.y = position.y;
  token.scale.set(
    baseScale * (placed.flippedX ? -(placed.scaleX || 1) : placed.scaleX || 1),
    baseScale * (placed.scaleY || 1),
  );
  token.skew.y = placed.skewY || 0;
  token.rotation = placed.rotation || 0;
  token.zIndex = placedLayerZ(placed);
  token.itemId = item.id;
  token.placedId = placed.placedId;
  if (!token.parent) {
    itemLayer.addChild(token);
  }
}

function destroyPlacedTokenView(placedId) {
  const view = placedTokenViews.get(placedId);
  if (!view) return;
  if (view.token.parent) {
    view.token.parent.removeChild(view.token);
  }
  destroySceneChild(view.token);
  placedTokenViews.delete(placedId);
}

function syncPlacedTokens() {
  const liveIds = new Set();
  for (const placed of currentRoomPlaced()) {
    const item = ITEMS.find((candidate) => candidate.id === placed.id);
    if (!item) continue;
    liveIds.add(placed.placedId);
    let view = placedTokenViews.get(placed.placedId);
    if (!view) {
      view = createPlacedTokenView(placed, item);
      placedTokenViews.set(placed.placedId, view);
    }
    updatePlacedTokenView(view, placed, item);
    if (state.selectedPlacedId === placed.placedId) {
      drawSelectionControls(placed, item, view.token.zIndex);
    }
  }

  for (const placedId of placedTokenViews.keys()) {
    if (!liveIds.has(placedId)) {
      destroyPlacedTokenView(placedId);
    }
  }
}

function drawRoom() {
  if (roomStaticDirty) {
    drawRoomBase();
  }
  applyCameraTransform();
  syncSecondFloor();
  syncPlacedTokens();
  itemLayer.sortableChildren = true;
}

function drawPanel() {
  const panel = layout.panel;
  const items = availableItems();
  if (panel.horizontal) {
    const gridX = 14;
    const gridY = 20;
    const gap = 8;
    const cardWidth = 78;
    const cardHeight = 86;
    const contentWidth = gridX * 2 + items.length * cardWidth + Math.max(0, items.length - 1) * gap;
    const maxScroll = Math.max(0, contentWidth - panel.width);
    state.panelScroll = clamp(state.panelScroll, 0, maxScroll);

    addShadow(
      uiLayer,
      panel.x,
      panel.y,
      panel.width,
      panel.height + 18,
      26,
      PALETTE.panelShadow,
      6,
    );
    const shell = new PIXI.Graphics();
    drawRoundedBox(shell, panel.x, panel.y, panel.width, panel.height + 18, 26, {
      color: PALETTE.white,
      alpha: 1,
    });
    uiLayer.addChild(shell);

    const mask = new PIXI.Graphics();
    mask.roundRect(panel.x, panel.y + 10, panel.width, panel.height, 20);
    mask.fill(0xffffff);
    uiLayer.addChild(mask);

    const grid = new PIXI.Container();
    grid.x = panel.x - state.panelScroll;
    grid.y = panel.y;
    grid.mask = mask;
    uiLayer.addChild(grid);

    items.forEach((item, index) => {
      const x = gridX + index * (cardWidth + gap);
      grid.addChild(makeItemCard(item, x, gridY, cardWidth, cardHeight));
    });

    if (maxScroll > 0) {
      const track = new PIXI.Graphics();
      track.roundRect(panel.x + 14, panel.y + 7, panel.width - 28, 3, 3);
      track.fill({ color: PALETTE.panelShadow, alpha: 0.65 });
      const thumbWidth = Math.max(
        34,
        ((panel.width - 28) / contentWidth) * (panel.width - 28),
      );
      const thumbX =
        panel.x +
        14 +
        (state.panelScroll / maxScroll) * (panel.width - 28 - thumbWidth);
      track.roundRect(thumbX, panel.y + 6, thumbWidth, 5, 4);
      track.fill({ color: PALETTE.accent, alpha: 0.75 });
      uiLayer.addChild(track);
    }

    layout.panelContent = { maxScroll, horizontal: true };
    return;
  }

  const gridX = 18;
  const gridY = 50;
  const gap = 10;
  const cardWidth = (panel.width - 36 - gap * 2) / 3;
  const cardHeight = 91;
  const rows = Math.ceil(items.length / 3);
  const contentHeight =
    gridY + rows * cardHeight + Math.max(0, rows - 1) * gap + 10;
  const maxScroll = Math.max(0, contentHeight - panel.height);
  state.panelScroll = clamp(state.panelScroll, 0, maxScroll);

  addShadow(
    uiLayer,
    panel.x,
    panel.y,
    panel.width,
    panel.height,
    26,
    PALETTE.panelShadow,
    6,
  );
  const shell = new PIXI.Graphics();
  drawRoundedBox(shell, panel.x, panel.y, panel.width, panel.height, 26, {
    color: PALETTE.white,
    alpha: 1,
  });
  uiLayer.addChild(shell);

  const title = makeText("Предметы для комнат", {
    fontFamily: FONT.display,
    fontSize: 16,
    fontWeight: "700",
    fill: PALETTE.title,
  });
  title.x = panel.x + 18;
  title.y = panel.y + 15;
  uiLayer.addChild(title);

  const itemCount = makeText(`${ITEMS.length}`, {
    fontFamily: FONT.display,
    fontSize: 15,
    fontWeight: "700",
    fill: PALETTE.accent,
    alpha: 0.52,
  });
  itemCount.x = title.x + title.width + 8;
  itemCount.y = title.y + 1;
  uiLayer.addChild(itemCount);

  const mask = new PIXI.Graphics();
  mask.roundRect(
    panel.x + 12,
    panel.y + 45,
    panel.width - 24,
    panel.height - 57,
    16,
  );
  mask.fill(0xffffff);
  uiLayer.addChild(mask);

  const grid = new PIXI.Container();
  grid.x = panel.x;
  grid.y = panel.y - state.panelScroll;
  grid.mask = mask;
  uiLayer.addChild(grid);

  items.forEach((item, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = gridX + col * (cardWidth + gap);
    const y = gridY + row * (cardHeight + gap);
    grid.addChild(makeItemCard(item, x, y, cardWidth, cardHeight));
  });

  if (maxScroll > 0) {
    const track = new PIXI.Graphics();
    track.roundRect(
      panel.x + panel.width - 8,
      panel.y + 49,
      3,
      panel.height - 65,
      3,
    );
    track.fill({ color: PALETTE.panelShadow, alpha: 0.65 });
    const thumbHeight = Math.max(
      28,
      ((panel.height - 65) / contentHeight) * (panel.height - 65),
    );
    const thumbY =
      panel.y +
      49 +
      (state.panelScroll / maxScroll) * (panel.height - 65 - thumbHeight);
    track.roundRect(panel.x + panel.width - 9, thumbY, 5, thumbHeight, 4);
    track.fill({ color: PALETTE.accent, alpha: 0.75 });
    uiLayer.addChild(track);
  }

  layout.panelContent = { maxScroll };
}

function makeItemCard(item, x, y, width, height) {
  const card = new PIXI.Container();
  card.x = x;
  card.y = y;
  card.eventMode = "static";
  card.cursor = "grab";
  card.hitArea = new PIXI.Rectangle(0, 0, width, height);

  const bg = new PIXI.Graphics();
  drawRoundedBox(bg, 0, 0, width, height, 16, {
    color: PALETTE.card,
    alpha: 1,
  });
  card.addChild(bg);

  const sticker = makeSticker(item, 44);
  sticker.x = width / 2 - 22;
  sticker.y = 8;
  card.addChild(sticker);

  const label = makeText(item.name, {
    fontFamily: FONT.display,
    fontSize: 10.5,
    fontWeight: "600",
    fill: PALETTE.text,
    align: "center",
    wordWrapWidth: width - 8,
    lineHeight: 12,
  });
  label.anchor.set(0.5, 0);
  label.x = width / 2;
  label.y = 58;
  card.addChild(label);

  const questionButton = makeQuestionButton(width - 15, 15, () => {
    state.modalItemId = item.id;
    state.modalScroll = 0;
    requestRender();
  });
  card.addChild(questionButton);

  card.on("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    activeDrag = { type: "palette", itemId: item.id };
    dragGhost = makePlacedToken(item, 1);
    dragGhost.alpha = 0.86;
    dragLayer.addChild(dragGhost);
    positionDragGhost(event.global.x, event.global.y);
  });

  return card;
}

function drawModal() {
  clear(modalLayer);
  if (layout) layout.modalContent = null;
  const item = ITEMS.find((candidate) => candidate.id === state.modalItemId);
  if (!item) return;

  const overlay = new PIXI.Graphics();
  overlay.rect(0, 0, layout.width, layout.height);
  overlay.fill({ color: PALETTE.title, alpha: 0.35 });
  overlay.eventMode = "static";
  overlay.cursor = "pointer";
  overlay.on("pointertap", () => {
    state.modalItemId = null;
    requestRender();
  });
  modalLayer.addChild(overlay);

  const desktopModal = layout.desktop;
  const modalWidth = desktopModal
    ? Math.min(680, layout.width - 40)
    : Math.min(360, layout.width - 28);
  const maxModalHeight = Math.min(desktopModal ? 560 : 600, layout.height - 40);
  const leftColumnWidth = desktopModal ? 220 : 0;
  const contentX = desktopModal ? leftColumnWidth + 28 : 0;
  const contentWidth = desktopModal ? modalWidth - contentX - 28 : modalWidth;
  const headerBottom = desktopModal ? 34 : 172;
  const footerHeight = 76;

  const body = makeText(item.congrats, {
    fontFamily: FONT.body,
    fontSize: 14,
    fontWeight: "600",
    fill: PALETTE.text,
    align: "center",
    wordWrapWidth: desktopModal ? contentWidth - 24 : modalWidth - 48,
    lineHeight: 20,
  });
  const bodyHeight = body.height;
  const desiredHeight = headerBottom + bodyHeight + 16 + footerHeight;
  const modalHeight = Math.max(330, Math.min(desiredHeight, maxModalHeight));
  const contentAreaHeight = modalHeight - headerBottom - 10 - footerHeight;
  const needsScroll = bodyHeight > contentAreaHeight;
  const maxModalScroll = needsScroll ? bodyHeight - contentAreaHeight : 0;
  state.modalScroll = clamp(state.modalScroll || 0, 0, maxModalScroll);

  const x = (layout.width - modalWidth) / 2;
  const y = Math.max(
    20,
    Math.min(80, layout.height - modalHeight - 20),
  );
  addShadow(
    modalLayer,
    x,
    y,
    modalWidth,
    modalHeight,
    28,
    PALETTE.panelShadow,
    10,
  );

  const panel = new PIXI.Container();
  panel.x = x;
  panel.y = y;
  panel.eventMode = "static";
  panel.cursor = "default";
  panel.on("pointertap", (event) => event.stopPropagation());

  const bg = new PIXI.Graphics();
  drawRoundedBox(bg, 0, 0, modalWidth, modalHeight, 28, {
    color: PALETTE.white,
    alpha: 1,
  });
  panel.addChild(bg);

  const sticker = desktopModal
    ? makeItemSprite(item, 170, 170)
    : makeSticker(item, 72);
  if (desktopModal) {
    sticker.x = 28 + leftColumnWidth / 2;
    sticker.y = 118;
  } else {
    sticker.x = modalWidth / 2 - 36;
    sticker.y = 28;
  }
  panel.addChild(sticker);

  const name = makeText(item.name, {
    fontFamily: FONT.display,
    fontSize: desktopModal ? 24 : 22,
    fontWeight: "800",
    fill: PALETTE.title,
    align: "center",
    wordWrapWidth: desktopModal ? leftColumnWidth - 24 : 0,
    lineHeight: desktopModal ? 28 : 25,
  });
  name.anchor.set(0.5, 0);
  name.x = desktopModal ? 28 + leftColumnWidth / 2 : modalWidth / 2;
  name.y = desktopModal ? 212 : 114;
  panel.addChild(name);

  const author = makeText(`— ${item.giver}`, {
    fontFamily: FONT.body,
    fontSize: desktopModal ? 16 : 12.5,
    fontWeight: "700",
    fill: PALETTE.muted,
    align: "center",
    wordWrapWidth: desktopModal ? leftColumnWidth - 24 : 0,
  });
  author.anchor.set(0.5, 0);
  author.x = desktopModal ? 28 + leftColumnWidth / 2 : modalWidth / 2;
  author.y = name.y + name.height + (desktopModal ? 10 : 6);
  panel.addChild(author);

  const mask = new PIXI.Graphics();
  mask.rect(
    desktopModal ? contentX : 12,
    headerBottom,
    desktopModal ? contentWidth : modalWidth - 24,
    contentAreaHeight,
  );
  mask.fill({ color: 0xffffff, alpha: 1 });
  panel.addChild(mask);

  const bodyWrap = new PIXI.Container();
  bodyWrap.x = desktopModal ? contentX : 0;
  bodyWrap.y = headerBottom - state.modalScroll;
  bodyWrap.mask = mask;
  body.anchor.set(0.5, 0);
  body.x = desktopModal ? contentWidth / 2 : modalWidth / 2;
  body.y = 0;
  bodyWrap.addChild(body);
  panel.addChild(bodyWrap);

  if (needsScroll) {
    const track = new PIXI.Graphics();
    const trackX = desktopModal ? contentX + contentWidth + 8 : modalWidth - 10;
    track.roundRect(trackX, headerBottom + 4, 3, contentAreaHeight - 8, 3);
    track.fill({ color: PALETTE.panelShadow, alpha: 0.65 });
    const thumbHeight = Math.max(24, (contentAreaHeight / bodyHeight) * contentAreaHeight);
    const thumbY =
      headerBottom + 4 +
      (state.modalScroll / maxModalScroll) * (contentAreaHeight - 8 - thumbHeight);
    track.roundRect(trackX - 1, thumbY, 5, thumbHeight, 4);
    track.fill({ color: PALETTE.accent, alpha: 0.75 });
    panel.addChild(track);
  }

  const confirm = makeButton(
    "Спасибо!",
    desktopModal ? contentX + (contentWidth - 244) / 2 : modalWidth / 2 - 122,
    modalHeight - 60,
    244,
    44,
    (event) => {
      event.stopPropagation();
      state.modalItemId = null;
      requestRender();
    },
    { fill: PALETTE.accentLight, textColor: PALETTE.white, fontSize: 15 },
  );
  panel.addChild(confirm);
  modalLayer.addChild(panel);

  layout.modalContent = needsScroll
    ? { x, y, width: modalWidth, height: modalHeight, maxScroll: maxModalScroll }
    : null;
}

function renderAll() {
  if (!layout) return;
  renderQueued = false;
  sceneRenderQueued = false;
  clear(uiLayer);
  clear(dragLayer);
  dragGhost = null;
  drawBackground();
  drawHeader();
  drawSwitch();
  renderScene();
  drawPanel();
  drawModal();
  updateDebugState();
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    sceneRenderQueued = false;
    renderAll();
  });
}

function renderScene() {
  if (!layout) return;
  sceneRenderQueued = false;
  clear(controlLayer);
  drawRoom();
  updateDebugState();
}

function requestSceneRender() {
  if (renderQueued || sceneRenderQueued) return;
  sceneRenderQueued = true;
  requestAnimationFrame(() => {
    sceneRenderQueued = false;
    if (renderQueued) return;
    renderScene();
  });
}

function positionDragGhost(x, y) {
  if (!dragGhost) return;
  dragGhost.x = x;
  dragGhost.y = y;
}

function placeItemAt(itemId, x, y) {
  const scenePoint = screenToScenePoint({ x, y });
  const room = layout.room;
  const percentX = clamp(((scenePoint.x - room.x) / room.width) * 100, 6, 94);
  const percentY = clamp(((scenePoint.y - room.y) / room.height) * 100, 8, 94);
  const placed = {
    placedId: makePlacedId(itemId),
    id: itemId,
    roomId: currentRoom().id,
    x: percentX,
    y: percentY,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    skewY: 0,
    flippedX: false,
    layerOffset: 0,
  };
  state.placed.push(placed);
  state.selectedPlacedId = placed.placedId;
}

function pointInRoom(x, y) {
  const point = screenToScenePoint({ x, y });
  const room = layout.room;
  return (
    point.x >= room.x &&
    point.x <= room.x + room.width &&
    point.y >= room.y &&
    point.y <= room.y + room.height
  );
}

function pointInPanel(x, y) {
  const panel = layout.panel;
  return (
    x >= panel.x &&
    x <= panel.x + panel.width &&
    y >= panel.y &&
    y <= panel.y + panel.height
  );
}

function onPointerMove(event) {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, eventPoint(event));
    updateTouchCameraGesture();
    if (touchCameraGesture) return;
  }
  if (!activeDrag) return;
  const point = eventPoint(event);
  positionDragGhost(point.x, point.y);

  if (activeDrag.type === "camera-pan") {
    state.camera.x = activeDrag.startCameraX + point.x - activeDrag.startX;
    state.camera.y = activeDrag.startCameraY + point.y - activeDrag.startY;
    clampCamera();
    requestSceneRender();
    return;
  }

  if (activeDrag.type === "placed") {
    const scenePoint = screenToScenePoint(point);
    const placed = state.placed.find(
      (candidate) => candidate.placedId === activeDrag.placedId,
    );
    if (placed && pointInRoom(point.x, point.y)) {
      const room = layout.room;
      const targetX = scenePoint.x - (activeDrag.offsetX || 0);
      const targetY = scenePoint.y - (activeDrag.offsetY || 0);
      placed.x = clamp(((targetX - room.x) / room.width) * 100, 6, 94);
      placed.y = clamp(((targetY - room.y) / room.height) * 100, 8, 94);
      requestSceneRender();
    }
    return;
  }

  if (activeDrag.type === "transform") {
    const scenePoint = screenToScenePoint(point);
    const placed = state.placed.find(
      (candidate) => candidate.placedId === activeDrag.placedId,
    );
    if (!placed) return;

    if (activeDrag.mode === "rotate") {
      const angle = Math.atan2(
        scenePoint.y - activeDrag.center.y,
        scenePoint.x - activeDrag.center.x,
      );
      placed.rotation =
        activeDrag.startRotation + angle - activeDrag.startAngle;
      requestSceneRender();
      return;
    }

    const local = localTransformPoint(
      scenePoint,
      activeDrag.center,
      placed.rotation || 0,
    );
    const bounds = activeDrag.bounds || {
      right: 28,
      bottom: 28,
    };
    const horizontalScale = clamp(
      Math.abs(local.x) / (bounds.right * activeDrag.baseScale),
      PLACED_TRANSFORM.minScale,
      PLACED_TRANSFORM.maxScale,
    );
    const verticalScale = clamp(
      Math.abs(local.y) / (bounds.bottom * activeDrag.baseScale),
      PLACED_TRANSFORM.minScale,
      PLACED_TRANSFORM.maxScale,
    );

    if (activeDrag.mode === "horizontal") {
      placed.scaleX = horizontalScale;
      placed.skewY = clamp(
        activeDrag.startSkewY + local.y / (bounds.bottom * activeDrag.baseScale),
        -PLACED_TRANSFORM.maxSkew,
        PLACED_TRANSFORM.maxSkew,
      );
    } else if (activeDrag.mode === "vertical") {
      placed.scaleY = verticalScale;
    } else if (activeDrag.mode === "corner") {
      const requestedFactor = Math.max(
        horizontalScale / activeDrag.startScaleX,
        verticalScale / activeDrag.startScaleY,
      );
      const minFactor = Math.max(
        PLACED_TRANSFORM.minScale / activeDrag.startScaleX,
        PLACED_TRANSFORM.minScale / activeDrag.startScaleY,
      );
      const maxFactor = Math.min(
        PLACED_TRANSFORM.maxScale / activeDrag.startScaleX,
        PLACED_TRANSFORM.maxScale / activeDrag.startScaleY,
      );
      const factor = clamp(requestedFactor, minFactor, maxFactor);
      placed.scaleX = clamp(
        activeDrag.startScaleX * factor,
        PLACED_TRANSFORM.minScale,
        PLACED_TRANSFORM.maxScale,
      );
      placed.scaleY = clamp(
        activeDrag.startScaleY * factor,
        PLACED_TRANSFORM.minScale,
        PLACED_TRANSFORM.maxScale,
      );
    }
    requestSceneRender();
  }
}

function onPointerUp(event) {
  if (activePointers.has(event.pointerId)) {
    activePointers.delete(event.pointerId);
    if (touchCameraGesture && activePointers.size < 2) {
      touchCameraGesture = null;
      markSceneChangedScene();
      return;
    }
  }
  if (!activeDrag) return;
  const finishedDragType = activeDrag.type;
  const point = eventPoint(event);
  let sceneChanged = finishedDragType !== "palette";

  if (finishedDragType === "palette" && pointInRoom(point.x, point.y)) {
    placeItemAt(activeDrag.itemId, point.x, point.y);
    sceneChanged = true;
  }

  activeDrag = null;
  dragGhost = null;
  if (finishedDragType === "palette") {
    if (sceneChanged) {
      markSceneChanged();
    } else {
      requestRender();
    }
  } else {
    markSceneChangedScene();
  }
}

function eventPoint(event) {
  const rect = app.canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function onWheel(event) {
  const point = eventPoint(event);

  if (state.modalItemId && layout?.modalContent) {
    const modal = layout.modalContent;
    if (
      point.x >= modal.x &&
      point.x <= modal.x + modal.width &&
      point.y >= modal.y &&
      point.y <= modal.y + modal.height
    ) {
      const maxScroll = modal.maxScroll || 0;
      if (maxScroll > 0) {
        event.preventDefault();
        state.modalScroll = clamp(
          (state.modalScroll || 0) + event.deltaY,
          0,
          maxScroll,
        );
        requestRender();
      }
      return;
    }
  }

  if (!layout?.panelContent) return;
  if (layout.panelContent.horizontal && pointInPanel(point.x, point.y)) {
    const maxScroll = layout.panelContent.maxScroll || 0;
    if (maxScroll <= 0) return;
    event.preventDefault();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    state.panelScroll = clamp(state.panelScroll + delta, 0, maxScroll);
    requestRender();
    return;
  }
  if (pointInRoom(point.x, point.y)) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.004 : 0.0018));
    zoomCameraAt(point, factor);
    return;
  }
  if (!pointInPanel(point.x, point.y)) return;
  const maxScroll = layout.panelContent.maxScroll || 0;
  if (maxScroll <= 0) return;
  event.preventDefault();
  state.panelScroll = clamp(state.panelScroll + event.deltaY, 0, maxScroll);
  requestRender();
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function updateTouchCameraGesture() {
  if (activePointers.size < 2 || !touchCameraGesture) return;
  const points = [...activePointers.values()];
  const midpoint = pointerMidpoint(points[0], points[1]);
  const distance = pointerDistance(points[0], points[1]);
  const zoom = clamp(
    touchCameraGesture.startZoom * (distance / touchCameraGesture.startDistance),
    CAMERA_LIMITS.minZoom,
    CAMERA_LIMITS.maxZoom,
  );
  state.camera.zoom = zoom;
  state.camera.x =
    midpoint.x - touchCameraGesture.sceneMidpoint.x * state.camera.zoom;
  state.camera.y =
    midpoint.y - touchCameraGesture.sceneMidpoint.y * state.camera.zoom;
  clampCamera();
  requestSceneRender();
}

function onPointerDown(event) {
  const point = eventPoint(event);
  activePointers.set(event.pointerId, point);
  if (activePointers.size === 2) {
    const points = [...activePointers.values()];
    const midpoint = pointerMidpoint(points[0], points[1]);
    touchCameraGesture = {
      startDistance: pointerDistance(points[0], points[1]),
      startZoom: state.camera.zoom,
      sceneMidpoint: screenToScenePoint(midpoint),
    };
    activeDrag = null;
    dragGhost = null;
    return;
  }
  if (event.button === 1 && pointInRoom(point.x, point.y)) {
    event.preventDefault();
    startCameraPan(event);
  }
}

function updateDebugState() {
  const appNode = document.querySelector("#app");
  if (appNode) {
    appNode.dataset.canvasOnly = "true";
    appNode.dataset.itemCount = String(ITEMS.length);
    appNode.dataset.availableCount = String(availableItems().length);
    appNode.dataset.placedCount = String(currentRoomPlaced().length);
    appNode.dataset.totalPlacedCount = String(state.placed.length);
    appNode.dataset.activeRoomId = state.activeRoomId;
    appNode.dataset.selectedPlacedId = state.selectedPlacedId || "";
    appNode.dataset.placedState = JSON.stringify(state.placed);
    appNode.dataset.showSecondFloor = String(state.showSecondFloor);
    appNode.dataset.modalItemId = state.modalItemId || "";
    appNode.dataset.storageKey = STORAGE_KEY;
    appNode.dataset.storageSync = storageStatus;
    appNode.dataset.storageLastSavedAt = storageLastSavedAt;
    appNode.dataset.camera = JSON.stringify(state.camera);
    if (layout) {
      appNode.dataset.room = JSON.stringify(layout.room);
      appNode.dataset.panel = JSON.stringify(layout.panel);
      appNode.dataset.switchBox = JSON.stringify(layout.switchBox);
      appNode.dataset.secondFloor = layout.secondFloor
        ? JSON.stringify(layout.secondFloor)
        : "";
      appNode.dataset.desktop = String(layout.desktop);
    }
  }

  window.__kassyakaPixiDebug = {
    itemCount: ITEMS.length,
    availableCount: availableItems().length,
    placedCount: currentRoomPlaced().length,
    totalPlacedCount: state.placed.length,
    activeRoomId: state.activeRoomId,
    selectedPlacedId: state.selectedPlacedId,
    placedState: state.placed,
    showSecondFloor: state.showSecondFloor,
    modalItemId: state.modalItemId,
    storageKey: STORAGE_KEY,
    storageSync: storageStatus,
    storageLastSavedAt,
    camera: state.camera,
    canvasOnly: true,
    layout: layout
      ? {
          width: layout.width,
          height: layout.height,
          desktop: layout.desktop,
          room: layout.room,
          panel: layout.panel,
          switchBox: layout.switchBox,
        }
      : null,
    background: getBackgroundDebugState(),
  };
  syncBackgroundDebugDataset();
}

function syncBackgroundDebugDataset() {
  const appNode = document.querySelector("#app");
  if (!appNode) return;
  const debug = getBackgroundDebugState();
  appNode.dataset.backgroundDrifting = String(debug.drifting);
  appNode.dataset.backgroundDirection = debug.direction;
  appNode.dataset.backgroundTickerStarted = String(debug.tickerStarted);
  appNode.dataset.backgroundX = String(debug.position.x);
  appNode.dataset.backgroundY = String(debug.position.y);
  if (debug.strongOffset) {
    appNode.dataset.backgroundStrongX = String(debug.strongOffset.x);
    appNode.dataset.backgroundStrongY = String(debug.strongOffset.y);
  }
  if (debug.softOffset) {
    appNode.dataset.backgroundSoftX = String(debug.softOffset.x);
    appNode.dataset.backgroundSoftY = String(debug.softOffset.y);
  }
}

async function init() {
  if (!window.PIXI) {
    document.body.textContent = "Не удалось загрузить Pixi.js.";
    return;
  }

  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  app = new PIXI.Application();
  await app.init({
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  document.querySelector("#app").append(app.canvas);
  app.canvas.setAttribute("aria-label", "Kassyaka room decorator Pixi game");

  ITEMS = await loadItems();
  applyStoredSceneState(loadSceneState());
  await PIXI.Assets.load([
    ...ROOM_ORDER.map((roomId) => ROOMS[roomId].asset),
    ROOM_ASSETS.secondFloor,
    ...ITEMS.map((item) => item.asset),
  ]);

  root = app.stage;
  root.eventMode = "static";
  backgroundLayer = new PIXI.Container();
  roomLayer = new PIXI.Container();
  itemLayer = new PIXI.Container();
  controlLayer = new PIXI.Container();
  uiLayer = new PIXI.Container();
  modalLayer = new PIXI.Container();
  dragLayer = new PIXI.Container();

  root.addChild(
    backgroundLayer,
    roomLayer,
    itemLayer,
    controlLayer,
    uiLayer,
    modalLayer,
    dragLayer,
  );
  root.on("pointertap", () => {
    if (ignoreStageTapOnce) {
      ignoreStageTapOnce = false;
      return;
    }
    if (state.modalItemId) return;
    state.selectedPlacedId = null;
    requestSceneRender();
  });

  window.addEventListener("resize", resizeRenderer);
  app.canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  app.canvas.addEventListener("wheel", onWheel, { passive: false });
  app.canvas.addEventListener("auxclick", (event) => event.preventDefault());
  app.ticker.add(updateBackgroundDrift);

  resizeRenderer();
}

init().catch((error) => {
  console.error(error);
  document.body.textContent = "Не удалось запустить игру.";
});
