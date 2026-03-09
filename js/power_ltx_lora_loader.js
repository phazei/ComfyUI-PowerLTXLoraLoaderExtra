import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "phazei.PowerLTXLoraLoaderExtra",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PowerLTXLoraLoaderExtra") return;

        // ─────────────────────────────────────────────
        //  Layout Constants
        // ─────────────────────────────────────────────

        const ROW_H      = 30;  // Height of each LoRA row
        const START_Y    = 66;  // Y offset for first row (clears output slot labels + top margin)
        const BTN_H      = 25;  // Height of the "+ Add LoRA" button
        const BTN_PAD    = 5;   // Padding above the button
        const BOTTOM_PAD = 18;  // Padding below the button (clears resize handle)
        const MIN_WIDTH  = 500; // Minimum node width so name column stays usable
        const RIGHT_PAD  = 5;   // Right margin inside node

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
                    const menu = new LiteGraph.ContextMenu(loraList, {
                        event: e,
                        scale: Math.max(1, canvas.ds.scale),
                        callback: (v) => {
                            data[i].lora = v;
                            this.properties.lora_data = JSON.stringify(data);
                            syncToBackend(this);
                            this.setDirtyCanvas(true);
                        }
                    });

                    // Inject a search/filter input at the top of the context menu.
                    // Guard against menu.root being undefined (varies by ComfyUI version).
                    if (menu.root) {
                        const searchWrap = document.createElement("div");
                        searchWrap.style.cssText = "padding:5px;background:#333;border-bottom:1px solid #555;";
                        const input = document.createElement("input");
                        input.style.cssText = "width:100%;background:#222;color:#fff;border:1px solid #444;padding:4px;box-sizing:border-box;";
                        input.placeholder = "Search LoRAs...";
                        searchWrap.appendChild(input);
                        menu.root.prepend(searchWrap);
                        setTimeout(() => input.focus(), 10);
                        input.addEventListener("input", (ev) => {
                            const term = ev.target.value.toLowerCase();
                            menu.root.querySelectorAll(".litemenu-entry").forEach(item => {
                                item.style.display = item.textContent.toLowerCase().includes(term) ? "block" : "none";
                            });
                        });
                    }
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

            // Keep backend widget in sync on every repaint (covers workflow reload)
            syncToBackend(this);
            const data = JSON.parse(this.properties.lora_data || "[]");
            const C = getCols(this.size[0]);

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

                // Row background — highlighted when being dragged, otherwise alternating
                if (this.draggingRow === i) {
                    ctx.fillStyle = "#3a4a5a";    // blue-ish highlight for active drag
                } else {
                    ctx.fillStyle = i % 2 === 0 ? "#2a2a2a" : "#333333";
                }
                ctx.fillRect(5, rowY, this.size[0] - 10, ROW_H - 2);

                // Grip handle
                ctx.fillStyle = "#666";
                ctx.textAlign = "left";
                ctx.fillText("≡", C.GRIP.x + 2, rowY + 18);

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
                ctx.fillStyle = row.lora === "None" ? "#777" : "#FFF";
                ctx.textAlign = "left";
                const rawName = row.lora.split(/[\\/]/).pop();
                const maxChars = Math.max(5, Math.floor(C.NAME.w / 7));
                const shortName = rawName.length > maxChars
                    ? rawName.substring(0, maxChars - 1) + "…"
                    : rawName;
                ctx.fillText(shortName, C.NAME.x, rowY + 18);

                // Number value cells
                for (const col of C.nums) {
                    // Dark cell background
                    ctx.fillStyle = "#111";
                    ctx.fillRect(col.x, rowY + 4, col.w - 5, ROW_H - 10);

                    // Numeric value centred in the cell
                    ctx.fillStyle = "#00FFCC";
                    ctx.textAlign = "center";
                    ctx.fillText(
                        row[col.key].toFixed(2),
                        col.x + (col.w / 2) - 2,
                        rowY + 18
                    );
                }

                // Trash / delete icon
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("✕", C.TRASH.x + C.TRASH.w / 2, rowY + ROW_H / 2 + 4);
            }

            // --- "+ Add LoRA" button ---
            const addBtnY = START_Y + (data.length * ROW_H) + BTN_PAD;
            ctx.fillStyle = "#1e3c28";
            ctx.beginPath();
            ctx.roundRect(10, addBtnY, this.size[0] - 20, BTN_H, 4);
            ctx.fill();
            ctx.fillStyle = "#a8f0c3";
            ctx.textAlign = "center";
            ctx.fillText("+ Add LoRA", this.size[0] / 2, addBtnY + 17);

            // Reset text alignment for any downstream drawing
            ctx.textAlign = "left";
        };
    }
});
