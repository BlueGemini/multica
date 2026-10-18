"use client";

import { useMemo } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeViewWrapper, useReactNodeView, type NodeViewProps } from "@tiptap/react";
import { RichContent } from "../../rich-content/rich-content";
import { RichTableFrame } from "../../rich-content/rich-table";
import type { RichTableModel } from "../../rich-content/rich-table-model";

function serialize(editor: Editor, content: ProseMirrorNode[]): string {
  return (
    editor.markdown?.serialize({ type: "doc", content: content.map((node) => node.toJSON()) }).trim() ?? ""
  );
}

// Serialized only when the expanded view renders it, not on every keystroke.
function TableCellContent({ cell, editor }: { cell: ProseMirrorNode; editor: Editor }) {
  const markdown = useMemo(() => {
    const blocks: ProseMirrorNode[] = [];
    cell.forEach((block) => {
      blocks.push(block);
    });
    return serialize(editor, blocks);
  }, [cell, editor]);
  return <RichContent content={markdown} density="compact" />;
}

function cellText(cell: ProseMirrorNode): string {
  return cell.textBetween(0, cell.content.size, " ").trim();
}

export function tableModelFromNode(node: ProseMirrorNode, editor: Editor): RichTableModel {
  const grid: ProseMirrorNode[][] = [];
  node.forEach((row) => {
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => {
      cells.push(cell);
    });
    grid.push(cells);
  });
  const [head = [], ...body] = grid;
  const render = (cell: ProseMirrorNode, index: number) => (
    <TableCellContent key={index} cell={cell} editor={editor} />
  );
  return {
    header: head.map(render),
    rows: body.map((row) => row.map(render)),
    headerText: head.map(cellText),
    rowText: body.map((row) => row.map(cellText)),
  };
}

/**
 * The editor's table, in the same frame as readonly tables. ProseMirror keeps
 * owning the rows: its `<tbody>` is handed to the frame's `<table>`.
 */
export function TableView({ node, editor }: NodeViewProps) {
  const { nodeViewContentRef } = useReactNodeView();
  const model = useMemo(() => tableModelFromNode(node, editor), [node, editor]);
  return (
    <NodeViewWrapper className="table-node">
      <RichTableFrame
        model={model}
        getMarkdown={() => serialize(editor, [node])}
        tableRef={nodeViewContentRef}
      />
    </NodeViewWrapper>
  );
}
