import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "phazei.PowerLTXLoraLoaderExtra",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowerLTXLoraLoaderExtra") return;

        // ─────────────────────────────────────────────
        //  Layout Constants
        // ─────────────────────────────────────────────

        const ROW_H      = 24;  // Height of each LoRA row
        const START_Y    = 66;  // Y offset for first row (clears output slot labels + top margin)
        const BTN_H      = 25;  // Height of the "+ Add LoRA" button
        const BTN_PAD    = 5;   // Padding above the button
        const BOTTOM_PAD = 18;  // Padding below the button (clears resize handle)
        const MIN_WIDTH  = 500; // Minimum node width so name column stays usable
        const RIGHT_PAD  = 5;   // Right margin inside node

        // Row element vertical alignment (relative to rowY)
        const ROW_TEXT_BASELINE = Math.floor(ROW_H / 2) + 5;  // Baseline for text (grip, name, numbers)
        const ROW_NUM_BOX_TOP   = 4;                           // Top offset for number box background
        const ROW_NUM_BOX_H     = ROW_H - 8;                   // Height of number box (ROW_H - top - bottom margin)

        // Config editor button (⚙) — positioned above column headers
        const COG_BTN_W = 24;
        const COG_BTN_H = 20;
        const getCogBtnPos = (nodeW) => ({
            x: nodeW - 110,
            y: START_Y - 60,
            w: COG_BTN_W,
            h: COG_BTN_H
        });

        // Fixed column widths (left-anchored columns)
        const GRIP_X   = 12;   // 5px left padding before the grip
        const GRIP_W   = 15;    // Tight around the "≡" glyph
        const TOGGLE_X = GRIP_X + GRIP_W;        // 18
        const TOGGLE_W = 22;   // Toggle dot centred at ~29px from left edge
        const NAME_X   = TOGGLE_X + TOGGLE_W + 5; // 45 — 5px gap after toggle

        // Fixed column widths (right-anchored columns)
        const NUM_W    = 50;   // Width of each numeric column
        const TRASH_W  = 30;   // Width of the trash column
        // Total fixed width on the right: 6 number cols + trash + right padding
        const RIGHT_FIXED = (6 * NUM_W) + TRASH_W + RIGHT_PAD; // 335

        // Column key/label definitions for the 6 numeric columns (in order)
        const NUM_DEFS = [
            { key: "str",   label: "STR"   },
            { key: "vid",   label: "Vid"   },
            { key: "v2a",   label: "V2A"   },
            { key: "aud",   label: "Aud"   },
            { key: "a2v",   label: "A2V"   },
            { key: "other", label: "Other" },
        ];

        /**
         * Computes dynamic column positions based on current node width.
         * The name column expands to fill available space; numeric columns
         * and trash are anchored to the right edge.
         *
         * @param {number} nodeW - Current node width (this.size[0])
         * @returns {object} Column layout with {GRIP, TOGGLE, NAME, nums[], TRASH}
         */
        const getCols = (nodeW) => {
            // Right-anchored block starts here
            const rightBlockX = nodeW - RIGHT_FIXED;

            // Name column fills the gap between left-anchored and right-anchored
            const nameW = rightBlockX - NAME_X;

            // Build numeric column positions
            const nums = [];
            for (let i = 0; i < NUM_DEFS.length; i++) {
                nums.push({
                    x:     rightBlockX + (i * NUM_W),
                    w:     NUM_W,
                    key:   NUM_DEFS[i].key,
                    label: NUM_DEFS[i].label,
                });
            }

            return {
                GRIP:   { x: GRIP_X,   w: GRIP_W   },
                TOGGLE: { x: TOGGLE_X, w: TOGGLE_W },
                NAME:   { x: NAME_X,   w: nameW    },
                nums,
                TRASH:  { x: rightBlockX + (6 * NUM_W), w: TRASH_W },
            };
        };

        /** Creates a default empty LoRA row */
        const makeEmptyRow = () => ({
            on: true, lora: "None",
            str: 1.0, vid: 1.0, v2a: 1.0, aud: 1.0, a2v: 1.0, other: 1.0
        });

        // ─────────────────────────────────────────────
        //  Node Lifecycle
        // ─────────────────────────────────────────────

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            // Initialise properties with one empty slot if this is a new node
            this.properties = this.properties || {};
            if (!this.properties.lora_data) {
                this.properties.lora_data = JSON.stringify([makeEmptyRow()]);
            }

            // Hide the lora_data widget so ComfyUI doesn't render it as a text field.
            // "converted-widget" tells ComfyUI to skip drawing; draw() no-op is a safety net.
            const w = this.widgets?.find(w => w.name === "lora_data");
            if (w) {
                w.type = "converted-widget";
                w.computeSize = () => [0, -4];
                w.draw = () => {};
            }

            // Remove the lora_data input slot — it's managed internally via
            // properties and the hidden widget.  The visible slot would be
            // confusing and overlaps the first row's drag grip.
            const slotIdx = this.inputs?.findIndex(inp => inp.name === "lora_data");
            if (slotIdx !== undefined && slotIdx >= 0) {
                this.removeInput(slotIdx);
            }

            // Mouse-interaction state trackers
            this.draggingRow   = null;  // Index of row being drag-reordered
            this.slidingNumber = null;  // { rowIdx, key, startX, startVal, moved }

            // Force correct initial size so the Add button isn't clipped.
            // Deferred to next frame so LiteGraph has finished its own init.
            requestAnimationFrame(() => {
                const sz = this.computeSize();
                // On first creation, use minimum width; preserve user width otherwise
                this.setSize([Math.max(sz[0], this.size?.[0] || 0), sz[1]]);
                this.setDirtyCanvas(true, true);
            });
        };

        // ─────────────────────────────────────────────
        //  Backend Sync
        // ─────────────────────────────────────────────

        /**
         * Pushes the UI data into the hidden widget that ComfyUI serialises
         * for Python.  Only rows with a LoRA selected (lora !== "None") are
         * sent — empty placeholder rows are excluded.  The Python backend
         * handles the active/inactive distinction itself (for model patching
         * vs. the lora_data output port).
         */
        const syncToBackend = (node) => {
            const widget = node.widgets?.find(w => w.name === "lora_data");
            if (!widget) return;

            const allRows = JSON.parse(node.properties.lora_data || "[]");
            const selectedRows = allRows.filter(row => row.lora !== "None");
            widget.value = JSON.stringify(selectedRows);
        };

        // ─────────────────────────────────────────────
        //  Size Calculation
        // ─────────────────────────────────────────────

        nodeType.prototype.computeSize = function () {
            const data = JSON.parse(this.properties.lora_data || "[]");
            const height = START_Y + (data.length * ROW_H) + BTN_PAD + BTN_H + BOTTOM_PAD;
            // Return minimum dimensions — LiteGraph uses this as the floor.
            // The user can drag wider; the dynamic layout adapts via getCols().
            return [MIN_WIDTH, height];
        };

        // ─────────────────────────────────────────────
        //  Mouse Down
        // ─────────────────────────────────────────────

        nodeType.prototype.onMouseDown = function (e, local_pos, canvas) {
            if (this.flags.collapsed) return;
            let data = JSON.parse(this.properties.lora_data || "[]");
            const [x, y] = local_pos;
            const C = getCols(this.size[0]);

            // --- Config editor button (⚙ cogwheel) ---
            const cogBtn = getCogBtnPos(this.size[0]);
            if (x >= cogBtn.x && x < cogBtn.x + cogBtn.w &&
                y >= cogBtn.y && y < cogBtn.y + cogBtn.h) {
                // Open config editor with compact JSON
                const compactJson = JSON.stringify(data);
                canvas.prompt("LoRA Config (JSON)", compactJson, (value) => {
                    try {
                        const parsed = JSON.parse(value);
                        // Validate: must be an array
                        if (!Array.isArray(parsed)) {
                            console.warn("[PowerLTX] Invalid config: not an array");
                            return;
                        }
                        // Sanitize each row: ensure required keys exist
                        const sanitized = parsed.map(row => ({
                            on:    row.on !== undefined ? row.on : true,
                            lora:  row.lora || "None",
                            str:   row.str !== undefined ? parseFloat(row.str) : 1.0,
                            vid:   row.vid !== undefined ? parseFloat(row.vid) : 1.0,
                            v2a:   row.v2a !== undefined ? parseFloat(row.v2a) : 1.0,
                            aud:   row.aud !== undefined ? parseFloat(row.aud) : 1.0,
                            a2v:   row.a2v !== undefined ? parseFloat(row.a2v) : 1.0,
                            other: row.other !== undefined ? parseFloat(row.other) : 1.0,
                        }));
                        // Apply the validated config
                        this.properties.lora_data = JSON.stringify(sanitized);
                        syncToBackend(this);
                        const sz = this.computeSize();
                        this.setSize([Math.max(sz[0], this.size[0]), sz[1]]);
                        this.setDirtyCanvas(true, true);
                    } catch (err) {
                        console.warn("[PowerLTX] Invalid JSON, ignoring:", err);
                        // Do nothing — data stays unchanged
                    }
                }, e);
                return true;
            }

            // --- "+ Add LoRA" button ---
            const addBtnY = START_Y + (data.length * ROW_H) + BTN_PAD;
            if (y > addBtnY && y < addBtnY + BTN_H) {
                data.push(makeEmptyRow());
                this.properties.lora_data = JSON.stringify(data);
                syncToBackend(this);
                // Grow height for the new row; preserve current user-set width
                const sz = this.computeSize();
                this.setSize([Math.max(sz[0], this.size[0]), sz[1]]);
                this.setDirtyCanvas(true, true);
                return true;
            }

            // --- Row interactions ---
            for (let i = 0; i < data.length; i++) {
                const rowY = START_Y + (i * ROW_H);
                if (y < rowY || y >= rowY + ROW_H) continue;

                // 1. Drag grip — initiates row reordering
                if (x >= C.GRIP.x && x < C.GRIP.x + C.GRIP.w) {
                    this.draggingRow = i;
                    return true;
                }

                // 2. Toggle on/off
                if (x >= C.TOGGLE.x && x < C.TOGGLE.x + C.TOGGLE.w) {
                    data[i].on = !data[i].on;
                    this.properties.lora_data = JSON.stringify(data);
                    syncToBackend(this);
                    this.setDirtyCanvas(true);
                    return true;
                }

                // 3. LoRA name — opens searchable selection menu
                if (x >= C.NAME.x && x < C.NAME.x + C.NAME.w) {
                    const loraList = nodeData.input.hidden.available_loras[0];
                    new LiteGraph.ContextMenu(loraList, {
                        event: e,
                        title: "Choose a lora",
                        className: "dark",
                        scale: Math.max(1, canvas.ds.scale),
                        callback: (v) => {
                            data[i].lora = v;
                            this.properties.lora_data = JSON.stringify(data);
                            syncToBackend(this);
                            this.setDirtyCanvas(true);
                        }
                    });
                    return true;
                }

                // 4. Trash — delete row immediately on mousedown.
                //    (LiteGraph does not reliably fire onMouseUp for quick clicks,
                //     so a mouseup-based approach fails for tap-to-delete.)
                if (x >= C.TRASH.x && x < C.TRASH.x + C.TRASH.w) {
                    data.splice(i, 1);
                    this.properties.lora_data = JSON.stringify(data);
                    syncToBackend(this);
                    // Shrink height for the removed row; preserve current width
                    const sz = this.computeSize();
                    this.setSize([Math.max(sz[0], this.size[0]), sz[1]]);
                    this.setDirtyCanvas(true, true);
                    return true;
                }

                // 5. Number columns — initiate click-drag slider
                for (const col of C.nums) {
                    if (x >= col.x && x < col.x + col.w) {
                        this.slidingNumber = {
                            rowIdx:   i,
                            key:      col.key,
                            startX:   local_pos[0],
                            startVal: data[i][col.key],
                            moved:    false
                        };
                        return true;
                    }
                }

                return true; // Click was inside a row but not on a control
            }
        };

        // ─────────────────────────────────────────────
        //  Mouse Move
        // ─────────────────────────────────────────────

        nodeType.prototype.onMouseMove = function (e, local_pos, canvas) {
            const [x, y] = local_pos;

            // ── Implicit mouseup detection ──
            // LiteGraph does NOT call onMouseUp on the node after a quick
            // click (mousedown -> mouseup with no/minimal drag).  It does,
            // however, keep calling onMouseMove.  We detect that the mouse
            // button has been released by checking e.buttons === 0 while
            // our state trackers are still active, and treat it as a
            // synthetic mouseup.
            if (e.buttons === 0) {

                // Grip drag was active but button is released -> stop dragging
                if (this.draggingRow !== null) {
                    this.draggingRow = null;
                    return;
                }

                // Number slider was active but button is released
                if (this.slidingNumber !== null) {
                    if (!this.slidingNumber.moved) {
                        // User quick-clicked a number cell without dragging.
                        // Open a text prompt so they can type an exact value.
                        const { rowIdx, key } = this.slidingNumber;
                        this.slidingNumber = null; // clear BEFORE prompt

                        let data = JSON.parse(this.properties.lora_data || "[]");
                        if (canvas && typeof canvas.prompt === "function") {
                            canvas.prompt("Value", data[rowIdx][key], (v) => {
                                const parsed = parseFloat(v);
                                if (!isNaN(parsed)) {
                                    // Re-read in case data changed while prompt was open
                                    data = JSON.parse(this.properties.lora_data || "[]");
                                    if (data[rowIdx]) {
                                        data[rowIdx][key] = parsed;
                                        this.properties.lora_data = JSON.stringify(data);
                                        syncToBackend(this);
                                        this.setDirtyCanvas(true);
                                    }
                                }
                            }, e);
                        }
                    } else {
                        this.slidingNumber = null;
                    }
                    return;
                }

                // No active state — nothing to do
                return;
            }

            // ── Active drag/slide handling (button is held) ──

            // --- Drag-and-drop row reordering ---
            if (this.draggingRow !== null) {
                let data = JSON.parse(this.properties.lora_data || "[]");
                let hoverIdx = Math.floor((y - START_Y) / ROW_H);
                hoverIdx = Math.max(0, Math.min(hoverIdx, data.length - 1));

                if (hoverIdx !== this.draggingRow) {
                    const item = data.splice(this.draggingRow, 1)[0];
                    data.splice(hoverIdx, 0, item);
                    this.draggingRow = hoverIdx;
                    this.properties.lora_data = JSON.stringify(data);
                    syncToBackend(this);
                    this.setDirtyCanvas(true);
                }
                return true;
            }

            // --- Number slider dragging ---
            if (this.slidingNumber !== null) {
                const deltaX = local_pos[0] - this.slidingNumber.startX;

                if (Math.abs(deltaX) > 2) {
                    this.slidingNumber.moved = true;
                }

                // 0.01 increment per pixel of horizontal movement
                let newVal = this.slidingNumber.startVal + (deltaX * 0.01);
                newVal = Math.round(newVal * 100) / 100;

                let data = JSON.parse(this.properties.lora_data || "[]");
                data[this.slidingNumber.rowIdx][this.slidingNumber.key] = newVal;
                this.properties.lora_data = JSON.stringify(data);
                syncToBackend(this);
                this.setDirtyCanvas(true);
                return true;
            }
        };

        // ─────────────────────────────────────────────
        //  Mouse Up
        // ─────────────────────────────────────────────
        //
        // LiteGraph only calls onMouseUp on the node reliably when there
        // was a real drag (mouse moved while button held).  For quick
        // clicks the cleanup happens in onMouseMove above via the
        // e.buttons===0 check.  This handler is a safety net for the
        // drag case and ensures state is always cleared.

        nodeType.prototype.onMouseUp = function () {
            if (this.slidingNumber !== null) {
                this.slidingNumber = null;
            }
            this.draggingRow = null;
        };

        // ─────────────────────────────────────────────
        //  Drawing
        // ─────────────────────────────────────────────

        nodeType.prototype.onDrawForeground = function (ctx) {
            if (this.flags.collapsed) return;
            
            ctx.save();  // Save canvas state to restore at the end

            // Keep backend widget in sync on every repaint (covers workflow reload)
            syncToBackend(this);
            const data = JSON.parse(this.properties.lora_data || "[]");
            const C = getCols(this.size[0]);

            // --- Config editor button (⚙) ---
            const cogBtn = getCogBtnPos(this.size[0]);
            ctx.fillStyle = "#2a2a2a";
            ctx.beginPath();
            ctx.roundRect(cogBtn.x, cogBtn.y, cogBtn.w, cogBtn.h, 3);
            ctx.fill();
            ctx.fillStyle = "#888";
            ctx.font = "14px Arial";
            ctx.textAlign = "center";
            ctx.fillText("⚙", cogBtn.x + cogBtn.w / 2, cogBtn.y + cogBtn.h / 2 + 5);

            // --- Column headers ---
            ctx.font = "bold 11px Arial";
            ctx.fillStyle = "#888";
            ctx.textAlign = "left";
            for (const col of C.nums) {
                ctx.fillText(col.label, col.x, START_Y - 10);
            }

            ctx.font = "12px Arial";

            // --- Rows ---
            for (let i = 0; i < data.length; i++) {
                const rowY = START_Y + (i * ROW_H);
                const row  = data[i];

                // Row background — highlighted when being dragged, otherwise subtle alternating
                if (this.draggingRow === i) {
                    // Stronger highlight for dragged row - noticeable on all themes
                    ctx.fillStyle = "rgba(100, 150, 255, 0.25)";
                    ctx.fillRect(5, rowY, this.size[0] - 10, ROW_H - 2);
                    // Add border for extra definition
                    ctx.strokeStyle = "rgba(100, 150, 255, 0.6)";
                    ctx.lineWidth = 2;
                    ctx.strokeRect(5, rowY, this.size[0] - 10, ROW_H - 2);
                } else {
                    // Subtle alternating rows with transparency (theme colors show through)
                    ctx.fillStyle = i % 2 === 0 ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.05)";
                    ctx.fillRect(5, rowY, this.size[0] - 10, ROW_H - 2);
                }

                // Grip handle with subtle background pill for visibility
                ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
                ctx.fillRect(C.GRIP.x, rowY + 2, C.GRIP.w, ROW_H - 4);
                ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#AAA";
                ctx.textAlign = "left";
                ctx.fillText("☰", C.GRIP.x + 2, rowY + ROW_TEXT_BASELINE);

                // Toggle dot — three visual states:
                //   Grey (#888):    no LoRA selected (lora === "None")
                //   Green (#4CAF50): LoRA selected and enabled
                //   Red (#f44336):   LoRA selected but disabled
                ctx.beginPath();
                const toggleCX = C.TOGGLE.x + C.TOGGLE.w / 2;
                const toggleCY = rowY + ROW_H / 2;
                ctx.arc(toggleCX, toggleCY, 7, 0, Math.PI * 2);
                if (row.lora === "None") {
                    ctx.fillStyle = "#888";
                } else if (row.on) {
                    ctx.fillStyle = "#4CAF50";
                } else {
                    ctx.fillStyle = "#f44336";
                }
                ctx.fill();

                // LoRA name — truncated to fit the dynamic name column width.
                // Estimate max characters based on column width (~7px per char at 12px Arial).
                // Use theme text color with reduced opacity for disabled or "None" rows
                if (row.lora === "None") {
                    ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#AAA";
                    ctx.globalAlpha = 0.4;
                } else if (!row.on) {
                    // Disabled row — muted text
                    ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#DDD";
                    ctx.globalAlpha = 0.35;
                } else {
                    ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#DDD";
                    ctx.globalAlpha = 1.0;
                }
                ctx.textAlign = "left";
                const rawName = row.lora.split(/[\\/]/).pop();
                // Use actual text measurement instead of character estimation
                const availableWidth = C.NAME.w - 5;  // Leave 5px right margin
                let displayName = rawName;
                if (ctx.measureText(rawName).width > availableWidth) {
                    // Truncate and add ellipsis, measuring as we go
                    for (let len = rawName.length - 1; len > 0; len--) {
                        const truncated = rawName.substring(0, len) + "…";
                        if (ctx.measureText(truncated).width <= availableWidth) {
                            displayName = truncated;
                            break;
                        }
                    }
                }
                ctx.fillText(displayName, C.NAME.x, rowY + ROW_TEXT_BASELINE);
                ctx.globalAlpha = 1.0;  // Reset alpha after drawing name

                // Number value cells
                for (const col of C.nums) {
                    // Dark cell background
                    ctx.fillStyle = "#111";
                    ctx.fillRect(col.x, rowY + ROW_NUM_BOX_TOP, col.w - 5, ROW_NUM_BOX_H);

                    // Numeric value centred in the cell — muted for disabled rows
                    ctx.fillStyle = "#00FFCC";
                    ctx.globalAlpha = row.on ? 1.0 : 0.35;
                    ctx.textAlign = "center";
                    ctx.fillText(
                        row[col.key].toFixed(2),
                        col.x + (col.w / 2) - 2,
                        rowY + ROW_TEXT_BASELINE
                    );
                }
                ctx.globalAlpha = 1.0;  // Reset alpha after number cells

                // Trash / delete icon
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("✕", C.TRASH.x + C.TRASH.w / 2, rowY + ROW_H / 2 + 4);
            }

            // --- "+ Add LoRA" button ---
            const addBtnY = START_Y + (data.length * ROW_H) + BTN_PAD;
            
            // Theme-aware button with subtle background and border
            ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
            ctx.beginPath();
            ctx.roundRect(10, addBtnY, this.size[0] - 20, BTN_H, 4);
            ctx.fill();
            
            // Border for definition
            ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
            ctx.lineWidth = 1;
            ctx.stroke();
            
            // Text in theme color
            ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#DDD";
            ctx.textAlign = "center";
            ctx.fillText("+ Add LoRA", this.size[0] / 2, addBtnY + 17);

            ctx.restore();  // Restore canvas state (font, colors, alpha, lineWidth, etc.)
        };
    }
});
