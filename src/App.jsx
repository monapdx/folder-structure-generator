import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as htmlToImage from "html-to-image";

const ROOT_ID = "root";

function uid() {
  return Math.random().toString(16).slice(2, 10);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

function icon(kind) {
  return kind === "folder" ? "📁" : "📄";
}

function isDescendant(nodes, nodeId, maybeAncestorId) {
  // returns true if nodeId is inside maybeAncestorId's subtree
  let cur = nodes[nodeId];
  while (cur && cur.parent) {
    if (cur.parent === maybeAncestorId) return true;
    cur = nodes[cur.parent];
  }
  return false;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Data model: nodes keyed by id.
 * Folder node:
 *   {id, kind:"folder", name, parent, children:[ids], isOpen:boolean}
 * File node:
 *   {id, kind:"file", name, parent}
 */
function defaultState() {
  return {
    [ROOT_ID]: {
      id: ROOT_ID,
      kind: "folder",
      name: "PROJECT",
      parent: null,
      children: [],
      isOpen: true,
    },
  };
}

function ensureFolder(nodes, name, parentId) {
  const parent = nodes[parentId];
  const existingId =
    parent.children.find((cid) => nodes[cid]?.kind === "folder" && nodes[cid]?.name === name) || null;
  if (existingId) return existingId;

  const id = uid();
  nodes[id] = { id, kind: "folder", name, parent: parentId, children: [], isOpen: true };
  parent.children.push(id);
  return id;
}

function ensureFile(nodes, name, parentId) {
  const parent = nodes[parentId];
  const exists = parent.children.some((cid) => nodes[cid]?.kind === "file" && nodes[cid]?.name === name);
  if (exists) return;

  const id = uid();
  nodes[id] = { id, kind: "file", name, parent: parentId };
  parent.children.push(id);
}

function buildFromNested(nested) {
  const nodes = defaultState();
  nodes[ROOT_ID].name = nested?.name || "PROJECT";

  function addChildren(parentId, children = []) {
    children.forEach((c) => {
      const id = uid();
      const kind = c.kind || "folder";
      const name = c.name || "untitled";
      if (kind === "folder") {
        nodes[id] = { id, kind, name, parent: parentId, children: [], isOpen: true };
        nodes[parentId].children.push(id);
        addChildren(id, c.children || []);
      } else {
        nodes[id] = { id, kind, name, parent: parentId };
        nodes[parentId].children.push(id);
      }
    });
  }

  addChildren(ROOT_ID, nested?.children || []);
  return nodes;
}

function toNested(nodes, rootId) {
  function build(id) {
    const n = nodes[id];
    const obj = { name: n.name, kind: n.kind };
    if (n.kind === "folder") obj.children = (n.children || []).map(build);
    return obj;
  }
  return build(rootId);
}

function unicodeTree(nodes, rootId) {
  const root = nodes[rootId];
  const lines = [root.name];

  function walk(parentId, prefix) {
    const children = nodes[parentId].children || [];
    children.forEach((cid, idx) => {
      const child = nodes[cid];
      const isLast = idx === children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(prefix + connector + child.name);

      if (child.kind === "folder") {
        const ext = isLast ? "    " : "│   ";
        walk(child.id, prefix + ext);
      }
    });
  }

  walk(rootId, "");
  return lines.join("\n");
}

function markdownTree(nodes, rootId) {
  const root = nodes[rootId];
  const lines = [`- **${root.name}**`];

  function walk(parentId, indent) {
    const pad = "  ".repeat(indent);
    const children = nodes[parentId].children || [];
    children.forEach((cid) => {
      const c = nodes[cid];
      if (c.kind === "folder") {
        lines.push(`${pad}- 📁 **${c.name}**`);
        walk(c.id, indent + 1);
      } else {
        lines.push(`${pad}- 📄 ${c.name}`);
      }
    });
  }

  walk(rootId, 1);
  return lines.join("\n");
}

function mermaid(nodes, rootId) {
  const safe = (s) => String(s).replaceAll('"', "'");
  const idMap = Object.keys(nodes).reduce((acc, id) => {
    acc[id] = `n_${id.replaceAll("-", "_")}`;
    return acc;
  }, {});
  const lines = ["flowchart TD"];
  Object.values(nodes).forEach((n) => {
    const mid = idMap[n.id];
    const label = safe(n.name);
    lines.push(`  ${mid}["${n.kind === "folder" ? "📁" : "📄"} ${label}"]`);
  });
  Object.values(nodes).forEach((n) => {
    if (n.parent) lines.push(`  ${idMap[n.parent]} --> ${idMap[n.id]}`);
  });
  return lines.join("\n");
}

function removeSubtree(nodes, nodeId) {
  const copy = clone(nodes);
  const parentId = copy[nodeId]?.parent;

  // collect subtree ids
  const stack = [nodeId];
  for (let i = 0; i < stack.length; i++) {
    const id = stack[i];
    const n = copy[id];
    if (n?.kind === "folder") {
      (n.children || []).forEach((cid) => stack.push(cid));
    }
  }

  // remove from parent's children
  if (parentId && copy[parentId]?.kind === "folder") {
    copy[parentId].children = copy[parentId].children.filter((cid) => cid !== nodeId);
  }

  // delete nodes
  stack.forEach((id) => {
    if (id !== ROOT_ID) delete copy[id];
  });

  return copy;
}

function moveNode(nodes, activeId, overId, mode) {
  // mode:
  // - "into" => put active into over folder (append)
  // - "before" => place active before overId in overId's parent
  // - "after"  => place active after overId in overId's parent
  const copy = clone(nodes);
  const active = copy[activeId];
  const over = copy[overId];

  if (!active || !over) return nodes;
  if (activeId === ROOT_ID) return nodes;
  if (activeId === overId) return nodes;

  // prevent moving folder into its own subtree
  if (active.kind === "folder") {
    if (mode === "into" && isDescendant(copy, overId, activeId)) return nodes;
    if ((mode === "before" || mode === "after") && isDescendant(copy, over.parent, activeId)) return nodes;
  }

  // remove from old parent
  const oldParent = copy[active.parent];
  if (oldParent?.kind === "folder") {
    oldParent.children = oldParent.children.filter((cid) => cid !== activeId);
  }

  if (mode === "into") {
    if (over.kind !== "folder") return nodes;
    active.parent = overId;
    copy[overId].children.push(activeId);
    copy[overId].isOpen = true;
    return copy;
  }

  // sibling move
  const targetParentId = over.parent || ROOT_ID;
  const targetParent = copy[targetParentId];
  if (!targetParent || targetParent.kind !== "folder") return nodes;

  active.parent = targetParentId;

  const idx = targetParent.children.indexOf(overId);
  const insertAt = mode === "before" ? Math.max(0, idx) : idx + 1;
  targetParent.children.splice(insertAt, 0, activeId);

  return copy;
}

function setChildrenOrder(nodes, parentId, newOrder) {
  const copy = clone(nodes);
  copy[parentId].children = newOrder;
  return copy;
}

/* ----------------- Sortable Row ----------------- */
function SortableRow({
  id,
  node,
  depth,
  selectedId,
  onSelect,
  onToggle,
  onContextMenu,
  highlight,
  scrollRefMap,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useEffect(() => {
    if (!scrollRefMap.current[id]) scrollRefMap.current[id] = null;
  }, [id, scrollRefMap]);

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={
          "row " +
          (selectedId === id ? "rowSelected " : "") +
          (highlight ? "rowHighlight " : "")
        }
        style={{ paddingLeft: 12 + depth * 26 }}
        onClick={() => onSelect(id)}
        onContextMenu={(e) => onContextMenu(e, id)}
        ref={(el) => (scrollRefMap.current[id] = el)}
      >
        <div className="rowLeft">
          <button
            className={"twist " + (node.kind === "folder" ? "" : "twistDisabled")}
            onClick={(e) => {
              e.stopPropagation();
              if (node.kind === "folder") onToggle(id);
            }}
            title={node.kind === "folder" ? (node.isOpen ? "Collapse" : "Expand") : ""}
          >
            {node.kind === "folder" ? (node.isOpen ? "▾" : "▸") : "•"}
          </button>

          <span className="rowIcon">{icon(node.kind)}</span>
          <span className="rowName">{node.name}</span>
        </div>

        <div className="rowRight">
          <span className="rowId">{id}</span>
          <span className="dragHandle" title="Drag to move" {...attributes} {...listeners}>
            ⠿
          </span>
        </div>
      </div>
    </div>
  );
}

/* ----------------- Tree Renderer ----------------- */
function Tree({
  nodes,
  parentId,
  depth,
  selectedId,
  onSelect,
  onToggle,
  onContextMenu,
  query,
  scrollRefMap,
}) {
  const parent = nodes[parentId];
  const children = parent.children || [];

  return (
    <div>
      <SortableContext items={children} strategy={verticalListSortingStrategy}>
        {children.map((cid) => {
          const n = nodes[cid];
          const highlight =
            query && n.name.toLowerCase().includes(query.toLowerCase());
          return (
            <React.Fragment key={cid}>
              <SortableRow
                id={cid}
                node={n}
                depth={depth}
                selectedId={selectedId}
                onSelect={onSelect}
                onToggle={onToggle}
                onContextMenu={onContextMenu}
                highlight={highlight}
                scrollRefMap={scrollRefMap}
              />
              {n.kind === "folder" && n.isOpen && (
                <Tree
                  nodes={nodes}
                  parentId={cid}
                  depth={depth + 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onContextMenu={onContextMenu}
                  query={query}
                  scrollRefMap={scrollRefMap}
                />
              )}
            </React.Fragment>
          );
        })}
      </SortableContext>
    </div>
  );
}

/* ----------------- Templates ----------------- */
const TEMPLATES = {
  "React app": {
    name: "my-react-app",
    kind: "folder",
    children: [
      { name: "src", kind: "folder", children: [{ name: "App.jsx", kind: "file" }, { name: "main.jsx", kind: "file" }] },
      { name: "public", kind: "folder", children: [] },
      { name: "package.json", kind: "file" },
      { name: "vite.config.js", kind: "file" },
      { name: "README.md", kind: "file" },
      { name: ".gitignore", kind: "file" },
    ],
  },
  "Python package": {
    name: "my-python-project",
    kind: "folder",
    children: [
      { name: "src", kind: "folder", children: [{ name: "my_package", kind: "folder", children: [{ name: "__init__.py", kind: "file" }] }] },
      { name: "tests", kind: "folder", children: [{ name: "test_smoke.py", kind: "file" }] },
      { name: "pyproject.toml", kind: "file" },
      { name: "README.md", kind: "file" },
      { name: "requirements.txt", kind: "file" },
      { name: ".gitignore", kind: "file" },
    ],
  },
  "Writing project": {
    name: "my-book",
    kind: "folder",
    children: [
      { name: "chapters", kind: "folder", children: [{ name: "01-opening.md", kind: "file" }, { name: "02-middle.md", kind: "file" }] },
      { name: "notes", kind: "folder", children: [{ name: "research.md", kind: "file" }, { name: "ideas.md", kind: "file" }] },
      { name: "assets", kind: "folder", children: [{ name: "cover.png", kind: "file" }] },
      { name: "README.md", kind: "file" },
    ],
  },
};

export default function App() {
  const [nodes, setNodes] = useState(() => defaultState());

  const [selectedId, setSelectedId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const [addKind, setAddKind] = useState("folder");
  const [addName, setAddName] = useState("");
  const [addParent, setAddParent] = useState(ROOT_ID);

  const [search, setSearch] = useState("");
  const [templateKey, setTemplateKey] = useState("React app");

  const treeWrapRef = useRef(null);
  const scrollRefMap = useRef({}); // id -> element

  // context menu state
  const [ctx, setCtx] = useState({
    open: false,
    x: 0,
    y: 0,
    targetId: null,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [draggingId, setDraggingId] = useState(null);

  const folderIds = useMemo(() => {
    return Object.values(nodes).filter((n) => n.kind === "folder").map((n) => n.id);
  }, [nodes]);

  // Keep addParent valid
  useEffect(() => {
    if (!nodes[addParent] || nodes[addParent].kind !== "folder") setAddParent(ROOT_ID);
  }, [addParent, nodes]);

  // Close context menu on click outside
  useEffect(() => {
    function onDocClick() {
      setCtx((p) => ({ ...p, open: false }));
    }
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, []);

  function onSelect(id) {
    setSelectedId(id);
    setRenameValue(nodes[id]?.name || "");
  }

  function toggleFolder(id) {
    setNodes((prev) => {
      const copy = clone(prev);
      if (copy[id]?.kind === "folder") copy[id].isOpen = !copy[id].isOpen;
      return copy;
    });
  }

  function addItem(kind, name, parentId) {
    const nm = (name || "").trim();
    if (!nm) return;

    setNodes((prev) => {
      const copy = clone(prev);
      const pid = parentId || ROOT_ID;
      if (!copy[pid] || copy[pid].kind !== "folder") return prev;

      const id = uid();
      if (kind === "folder") {
        copy[id] = { id, kind: "folder", name: nm, parent: pid, children: [], isOpen: true };
      } else {
        copy[id] = { id, kind: "file", name: nm, parent: pid };
      }
      copy[pid].children.push(id);
      copy[pid].isOpen = true;
      return copy;
    });

    setAddName("");
  }

  function deleteTarget(id) {
    setNodes((prev) => removeSubtree(prev, id));
    if (selectedId === id) {
      setSelectedId(null);
      setRenameValue("");
    }
  }

  function saveRename() {
    if (!selectedId) return;
    const nm = renameValue.trim();
    if (!nm) return;
    setNodes((prev) => {
      const copy = clone(prev);
      if (!copy[selectedId]) return prev;
      copy[selectedId].name = nm;
      return copy;
    });
  }

  function moveSelectedTo(parentId) {
    if (!selectedId) return;
    if (!nodes[parentId] || nodes[parentId].kind !== "folder") return;
    const sel = nodes[selectedId];

    if (sel.kind === "folder") {
      if (parentId === selectedId) return;
      if (isDescendant(nodes, parentId, selectedId)) return;
    }

    setNodes((prev) => {
      const copy = clone(prev);
      const oldParentId = copy[selectedId].parent;
      if (oldParentId && copy[oldParentId]?.kind === "folder") {
        copy[oldParentId].children = copy[oldParentId].children.filter((cid) => cid !== selectedId);
      }
      copy[selectedId].parent = parentId;
      copy[parentId].children.push(selectedId);
      copy[parentId].isOpen = true;
      return copy;
    });
  }

  function openContextMenu(e, id) {
    e.preventDefault();
    setCtx({ open: true, x: e.clientX, y: e.clientY, targetId: id });
  }

  function jumpToFirstMatch() {
    const q = search.trim().toLowerCase();
    if (!q) return;

    const match = Object.values(nodes).find((n) => n.id !== ROOT_ID && n.name.toLowerCase().includes(q));
    if (!match) return;

    // ensure all ancestors are opened
    setNodes((prev) => {
      const copy = clone(prev);
      let cur = copy[match.id];
      while (cur?.parent) {
        const p = copy[cur.parent];
        if (p?.kind === "folder") p.isOpen = true;
        cur = p;
      }
      return copy;
    });

    // scroll after open
    setTimeout(() => {
      const el = scrollRefMap.current[match.id];
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      onSelect(match.id);
    }, 80);
  }

  function applyTemplate(key) {
    const t = TEMPLATES[key];
    if (!t) return;
    const built = buildFromNested(t);
    setNodes(built);
    setSelectedId(null);
    setRenameValue("");
    setAddParent(ROOT_ID);
    setSearch("");
  }

  // ------- Drag & Drop Handlers -------
  function onDragStart(event) {
    setDraggingId(event.active?.id || null);
  }

  function onDragEnd(event) {
    const { active, over } = event;
    setDraggingId(null);

    if (!active?.id || !over?.id) return;
    const activeId = active.id;
    const overId = over.id;

    if (activeId === overId) return;

    const activeNode = nodes[activeId];
    const overNode = nodes[overId];
    if (!activeNode || !overNode) return;

    // 1) Reorder within same parent if both in same folder children list
    const aParent = activeNode.parent || ROOT_ID;
    const oParent = overNode.parent || ROOT_ID;

    // If over is a folder header, we treat drop as "into" folder
    // We detect folder drop by holding Alt? No — use Shift to drop as sibling.
    // Default:
    // - Dropping on folder => into folder
    // - Dropping on item => reorder as sibling under that item’s parent
    // You can force "into" by dropping on folder row; force "sibling" by holding Shift.
    const shift = window.__folderviz_shiftKeyDown === true;

    if (overNode.kind === "folder" && !shift) {
      setNodes((prev) => moveNode(prev, activeId, overId, "into"));
      return;
    }

    // sibling reorder/move to over’s parent
    // remove from active parent then insert around over
    setNodes((prev) => {
      const copy = clone(prev);

      // If same parent, use arrayMove for stable reorder
      const ap = copy[aParent];
      const op = copy[oParent];
      if (!ap || !op || ap.kind !== "folder" || op.kind !== "folder") return prev;

      // prevent illegal move into descendant via sibling move
      if (activeNode.kind === "folder") {
        if (isDescendant(copy, oParent, activeId)) return prev;
      }

      // remove from old
      ap.children = ap.children.filter((cid) => cid !== activeId);

      // insert in new parent around over index
      const idx = op.children.indexOf(overId);
      const insertAt = Math.max(0, idx); // place before over
      copy[activeId].parent = oParent;
      op.children.splice(insertAt, 0, activeId);
      op.isOpen = true;

      // If same parent, just reorder using arrayMove for better behavior
      if (aParent === oParent) {
        const order = op.children;
        const from = order.indexOf(activeId);
        const to = insertAt;
        op.children = arrayMove(order, from, to);
      }

      return copy;
    });
  }

  // Keep track of Shift key to force sibling drop
  useEffect(() => {
    function onDown(e) {
      window.__folderviz_shiftKeyDown = e.shiftKey;
    }
    function onUp(e) {
      window.__folderviz_shiftKeyDown = e.shiftKey;
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.__folderviz_shiftKeyDown = false;
    };
  }, []);

  // -------- Export helpers --------
  const treeText = useMemo(() => unicodeTree(nodes, ROOT_ID), [nodes]);
  const mdText = useMemo(() => markdownTree(nodes, ROOT_ID), [nodes]);
  const mmText = useMemo(() => mermaid(nodes, ROOT_ID), [nodes]);

  async function exportPng() {
    if (!treeWrapRef.current) return;
    const dataUrl = await htmlToImage.toPng(treeWrapRef.current, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
    });
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    downloadBlob("folder-tree.png", blob);
  }

  async function exportSvg() {
    if (!treeWrapRef.current) return;
    const dataUrl = await htmlToImage.toSvg(treeWrapRef.current, {
      backgroundColor: "#ffffff",
    });
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    downloadBlob("folder-tree.svg", blob);
  }

  function exportJson() {
    downloadText("structure.json", JSON.stringify({ root_id: ROOT_ID, nodes }, null, 2), "application/json");
  }

  function exportMd() {
    const md =
      `# Folder Structure\n\n## Tree (text)\n\n\`\`\`text\n${treeText}\n\`\`\`\n\n` +
      `## Tree (Markdown)\n\n${mdText}\n\n` +
      `## Mermaid\n\n\`\`\`mermaid\n${mmText}\n\`\`\`\n`;
    downloadText("structure.md", md, "text/markdown");
  }

  function exportTreeTxt() {
    downloadText("tree.txt", treeText, "text/plain");
  }

  function importJsonFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));

        // flat form
        if (data?.nodes && data?.root_id) {
          setNodes(data.nodes);
          setSelectedId(null);
          setRenameValue("");
          setAddParent(ROOT_ID);
          setSearch("");
        }
        // nested form
        else if (data && (data.kind === "folder" || !data.kind)) {
          setNodes(buildFromNested(data));
          setSelectedId(null);
          setRenameValue("");
          setAddParent(ROOT_ID);
          setSearch("");
        } else {
          alert("Unrecognized JSON format.");
        }
      } catch (err) {
        alert("Import failed: " + err);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  // -------- Folder dropdown for add/move --------
  const folderOptions = useMemo(() => {
    const arr = Object.values(nodes).filter((n) => n.kind === "folder");
    arr.sort((a, b) => (a.id === ROOT_ID ? -1 : b.id === ROOT_ID ? 1 : a.name.localeCompare(b.name)));
    return arr;
  }, [nodes]);

  const moveTargets = useMemo(() => {
    if (!selectedId) return folderOptions;
    const sel = nodes[selectedId];
    return folderOptions.filter((f) => {
      if (!sel) return true;
      if (sel.kind === "file") return true;
      if (f.id === selectedId) return false;
      if (isDescendant(nodes, f.id, selectedId)) return false;
      return true;
    });
  }, [folderOptions, nodes, selectedId]);

  // -------- Context menu actions --------
  const ctxTarget = ctx.targetId ? nodes[ctx.targetId] : null;

  function ctxAdd(kind) {
    if (!ctx.targetId) return;
    const target = nodes[ctx.targetId];
    const parentId = target.kind === "folder" ? target.id : target.parent || ROOT_ID;
    const name = kind === "folder" ? "New Folder" : "new-file.txt";
    addItem(kind, name, parentId);
    setCtx((p) => ({ ...p, open: false }));
  }

  function ctxRename() {
    if (!ctx.targetId) return;
    onSelect(ctx.targetId);
    setCtx((p) => ({ ...p, open: false }));
  }

  function ctxDelete() {
    if (!ctx.targetId) return;
    deleteTarget(ctx.targetId);
    setCtx((p) => ({ ...p, open: false }));
  }

  // ------- Drag overlay label -------
  const dragLabel = draggingId ? `${icon(nodes[draggingId]?.kind)} ${nodes[draggingId]?.name || ""}` : "";

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="title">
          <div className="h1">📁 Folder Structure Visualizer</div>
          <div className="sub">
            Drag & drop to move/reorder. Right click for actions. Hold <b>Shift</b> while dropping on a folder to drop as sibling.
          </div>
        </div>

        <div className="topActions">
          <div className="searchWrap">
            <input
              className="input"
              placeholder="Search… (name contains)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") jumpToFirstMatch();
              }}
            />
            <button className="btn" onClick={jumpToFirstMatch} title="Jump to first match">
              Jump
            </button>
          </div>
        </div>
      </header>

      <main className="grid">
        {/* LEFT PANEL */}
        <section className="panel">
          <div className="panelHead">
            <div className="panelTitle">Builder</div>
          </div>

          <div className="block">
            <label className="label">Root name</label>
            <input
              className="input"
              value={nodes[ROOT_ID].name}
              onChange={(e) =>
                setNodes((prev) => {
                  const copy = clone(prev);
                  copy[ROOT_ID].name = e.target.value;
                  return copy;
                })
              }
            />
          </div>

          <div className="divider" />

          <div className="block">
            <div className="rowInline">
              <button className={"pill " + (addKind === "folder" ? "pillOn" : "")} onClick={() => setAddKind("folder")}>
                📁 Folder
              </button>
              <button className={"pill " + (addKind === "file" ? "pillOn" : "")} onClick={() => setAddKind("file")}>
                📄 File
              </button>
            </div>

            <label className="label">Name</label>
            <input className="input" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="src, assets, README.md…" />

            <label className="label">Parent folder</label>
            <select className="input" value={addParent} onChange={(e) => setAddParent(e.target.value)}>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.id === ROOT_ID ? " (root)" : ""}
                </option>
              ))}
            </select>

            <button className="btnPrimary" onClick={() => addItem(addKind, addName, addParent)}>
              ➕ Add
            </button>
          </div>

          <div className="divider" />

          <div className="block">
            <div className="rowInline" style={{ justifyContent: "space-between" }}>
              <div className="label" style={{ margin: 0 }}>
                Templates
              </div>
              <button className="btnGhost" onClick={() => applyTemplate(templateKey)}>
                Apply
              </button>
            </div>
            <select className="input" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              {Object.keys(TEMPLATES).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <div className="hint">Applies a starter structure (replaces current tree).</div>
          </div>

          <div className="divider" />

          <div className="block">
            <div className="panelTitle" style={{ fontSize: 14, marginBottom: 8 }}>
              Selected item
            </div>

            {!selectedId ? (
              <div className="hint">Click an item in the tree to rename/move/delete.</div>
            ) : (
              <>
                <div className="selectedLine">
                  <span className="selIcon">{icon(nodes[selectedId].kind)}</span>
                  <span className="selName">{nodes[selectedId].name}</span>
                  <span className="selMeta">{selectedId}</span>
                </div>

                <label className="label">Rename</label>
                <input className="input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                <button className="btn" onClick={saveRename}>
                  💾 Save rename
                </button>

                <label className="label">Move to folder</label>
                <select className="input" value={nodes[selectedId].parent || ROOT_ID} onChange={(e) => moveSelectedTo(e.target.value)}>
                  {moveTargets.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {f.id === ROOT_ID ? " (root)" : ""}
                    </option>
                  ))}
                </select>
                {nodes[selectedId].kind === "folder" && <div className="hint">Folders can’t be moved into themselves/descendants.</div>}

                <button className="btnDanger" onClick={() => deleteTarget(selectedId)}>
                  🗑️ Delete {nodes[selectedId].kind === "folder" ? "subtree" : "file"}
                </button>
              </>
            )}
          </div>

          <div className="divider" />

          <div className="block">
            <div className="panelTitle" style={{ fontSize: 14, marginBottom: 8 }}>
              Import / Reset
            </div>

            <label className="label">Import JSON</label>
            <input type="file" accept=".json,application/json" onChange={importJsonFile} />
            <div className="hint">Accepts either exported structure.json or nested JSON.</div>

            <button
              className="btnGhost"
              onClick={() => {
                setNodes(defaultState());
                setSelectedId(null);
                setRenameValue("");
                setAddParent(ROOT_ID);
                setSearch("");
              }}
            >
              🧹 Reset
            </button>
          </div>
        </section>

        {/* RIGHT PANEL */}
        <section className="panel">
          <div className="panelHead">
            <div className="panelTitle">Tree</div>
            <div className="panelRightHint">Right click an item for actions.</div>
          </div>

          <div className="treeWrap" ref={treeWrapRef}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            >
              {/* Root header (not draggable) */}
              <div
                className={"row rowRoot " + (search && nodes[ROOT_ID].name.toLowerCase().includes(search.toLowerCase()) ? "rowHighlight" : "")}
                onContextMenu={(e) => openContextMenu(e, ROOT_ID)}
              >
                <div className="rowLeft">
                  <button className="twist" onClick={() => toggleFolder(ROOT_ID)}>
                    {nodes[ROOT_ID].isOpen ? "▾" : "▸"}
                  </button>
                  <span className="rowIcon">📁</span>
                  <span className="rowName">{nodes[ROOT_ID].name}</span>
                </div>
                <div className="rowRight">
                  <span className="rowId">{ROOT_ID}</span>
                </div>
              </div>

              {nodes[ROOT_ID].isOpen && (
                <Tree
                  nodes={nodes}
                  parentId={ROOT_ID}
                  depth={0}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onToggle={toggleFolder}
                  onContextMenu={openContextMenu}
                  query={search.trim()}
                  scrollRefMap={scrollRefMap}
                />
              )}

              <DragOverlay>
                {draggingId ? (
                  <div className="dragOverlay">{dragLabel}</div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          {/* Export row */}
          <div className="exportBar">
            <button className="btn" onClick={exportTreeTxt}>
              ⬇️ tree.txt
            </button>
            <button className="btn" onClick={exportJson}>
              ⬇️ JSON
            </button>
            <button className="btn" onClick={exportMd}>
              ⬇️ Markdown
            </button>
            <button className="btn" onClick={exportPng}>
              ⬇️ PNG
            </button>
            <button className="btn" onClick={exportSvg}>
              ⬇️ SVG
            </button>
          </div>

          {/* Quick previews */}
          <details className="details">
            <summary>Preview: tree.txt</summary>
            <pre className="pre">{treeText}</pre>
          </details>

          <details className="details">
            <summary>Preview: Mermaid</summary>
            <pre className="pre">{mmText}</pre>
          </details>
        </section>
      </main>

      {/* Context menu */}
      {ctx.open && (
        <div className="ctxMenu" style={{ left: ctx.x, top: ctx.y }}>
          <div className="ctxTitle">
            {ctxTarget ? `${icon(ctxTarget.kind)} ${ctxTarget.name}` : "Actions"}
          </div>

          <button className="ctxItem" onClick={() => ctxAdd("folder")}>
            ➕ Add folder here
          </button>
          <button className="ctxItem" onClick={() => ctxAdd("file")}>
            ➕ Add file here
          </button>

          <div className="ctxSep" />

          <button className="ctxItem" onClick={ctxRename}>
            ✏️ Rename
          </button>

          {ctx.targetId !== ROOT_ID && (
            <button className="ctxItem ctxDanger" onClick={ctxDelete}>
              🗑️ Delete
            </button>
          )}

          <div className="ctxHint">Tip: Hold <b>Shift</b> while dropping onto a folder to drop as sibling.</div>
        </div>
      )}
    </div>
  );
}
