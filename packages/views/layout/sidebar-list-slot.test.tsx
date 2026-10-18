import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";
import {
  SidebarListSlot,
  SidebarListSlotProvider,
  useSidebarListSlot,
} from "./sidebar-list-slot";

function Page({ active = true }: { active?: boolean }) {
  const slot = useSidebarListSlot(active);
  const list = <p>list</p>;
  return (
    <main data-testid="page">
      {slot ? createPortal(list, slot) : list}
    </main>
  );
}

describe("SidebarListSlot", () => {
  it("moves the page's list into the published slot", () => {
    const { container } = render(
      <SidebarListSlotProvider>
        <aside>
          <SidebarListSlot />
        </aside>
        <Page />
      </SidebarListSlotProvider>,
    );

    const slot = container.querySelector('[data-slot="sidebar-list-slot"]')!;
    expect(slot).toHaveTextContent("list");
    expect(screen.getByTestId("page")).not.toHaveTextContent("list");
  });

  it("leaves the list in the page when no slot is published", () => {
    render(
      <SidebarListSlotProvider>
        <Page />
      </SidebarListSlotProvider>,
    );
    expect(screen.getByTestId("page")).toHaveTextContent("list");
  });

  it("never lets an inactive page claim the slot", () => {
    render(
      <SidebarListSlotProvider>
        <SidebarListSlot />
        <Page active={false} />
      </SidebarListSlotProvider>,
    );
    expect(screen.getByTestId("page")).toHaveTextContent("list");
  });

  it("works outside a provider", () => {
    render(<Page />);
    expect(screen.getByTestId("page")).toHaveTextContent("list");
  });
});
