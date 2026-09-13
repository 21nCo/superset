import React, { useEffect, useMemo, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Checkbox,
  CheckboxIndicator,
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogBackdrop,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  Menu as DropdownMenu,
  MenuContent as DropdownMenuContent,
  MenuItem as DropdownMenuItem,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator as DropdownMenuSeparator,
  MenuTrigger as DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValueText as SelectValue,
  Switch,
  SwitchThumb,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from "@uifn/react";
import { VirtualizedList } from "./VirtualizedList";
import {
  capabilitySupport,
  commandItems,
  defaultExampleRoute,
  getScenarioRoute,
  normalizeExampleRoute,
  resultRows,
  scenarios,
  settingsSections,
  settingsToggles,
  teamMembers,
  type ExampleCapabilitySupport,
  type ExampleRouteHash,
  type ExampleScenarioId,
} from "@uifn/examples-shared";

type ScenarioComponentProps = {
  route: ExampleRouteHash;
};

const scenarioComponentById: Record<ExampleScenarioId, React.FC<ScenarioComponentProps>> = {
  "settings-console": SettingsConsoleScenario,
  "team-directory": TeamDirectoryScenario,
  "command-center": CommandCenterScenario,
  "virtualized-results": VirtualizedResultsScenario,
};

const reactCapabilityMatrix = capabilitySupport.filter(
  (entry) => entry.adapter === "react",
);

const memberActionItems = [
  { id: "message", value: "message", label: "Message teammate", textValue: "Message teammate" },
  { id: "review", value: "review", label: "Assign reviewer", textValue: "Assign reviewer" },
  { id: "profile", value: "profile", label: "Open profile", textValue: "Open profile" },
] as const;

const commandMenuItems = [
  { id: "run", value: "run", label: "Run selected command", textValue: "Run selected command" },
  { id: "copy", value: "copy", label: "Copy route", textValue: "Copy route" },
  { id: "pin", value: "pin", label: "Pin to favorites", textValue: "Pin to favorites" },
] as const;

function useNormalizedHashRoute(initialRoute?: ExampleRouteHash) {
  const readRoute = () =>
    initialRoute
      ? normalizeExampleRoute(initialRoute)
      :
    typeof window === "undefined"
      ? defaultExampleRoute
      : normalizeExampleRoute(window.location.hash);

  const [route, setRoute] = useState<ExampleRouteHash>(readRoute);

  useEffect(() => {
    if (initialRoute || typeof window === "undefined") {
      return;
    }

    const syncRoute = () => {
      const normalized = normalizeExampleRoute(window.location.hash);
      if (window.location.hash !== normalized) {
        window.location.hash = normalized;
      }
      setRoute(normalized);
    };

    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return initialRoute ? normalizeExampleRoute(initialRoute) : route;
}

export function App({ initialRoute }: { initialRoute?: ExampleRouteHash } = {}) {
  const route = useNormalizedHashRoute(initialRoute);
  const activeScenario = useMemo(() => {
    const activeId = route.replace("#/", "") as ExampleScenarioId;
    return scenarios.find((scenario) => scenario.id === activeId) ?? scenarios[0];
  }, [route]);
  const ScenarioComponent = scenarioComponentById[activeScenario.id];

  return (
    <main className="app-shell">
        <section className="hero-panel">
          <div>
            <p className="eyebrow">uifn examples</p>
            <h1>React Playground</h1>
            <p className="hero-copy">
              Scenario-driven demos for the GA React adapter, using the shared
              example registry and capability matrix.
            </p>
          </div>
          <Badge className="adapter-badge" variant="secondary">
            React
          </Badge>
        </section>

        <div className="workspace-grid">
          <aside className="panel navigation-panel" aria-label="Scenario navigation">
            <h2>Scenarios</h2>
            <nav>
              <ul className="scenario-list">
                {scenarios.map((scenario) => {
                  const href = getScenarioRoute(scenario.id);
                  const isActive = scenario.id === activeScenario.id;

                  return (
                    <li key={scenario.id}>
                      <a
                        className={isActive ? "scenario-link active" : "scenario-link"}
                        href={href}
                        aria-current={isActive ? "page" : undefined}
                      >
                        <span>{scenario.title}</span>
                        <small>{scenario.description}</small>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </aside>

          <section className="panel scenario-panel" aria-labelledby="active-scenario-heading">
            <div className="panel-heading">
              <div>
                <p className="section-label">Active route</p>
                <h2 id="active-scenario-heading">{activeScenario.title}</h2>
              </div>
              <code>{route}</code>
            </div>
            <p className="scenario-description">{activeScenario.description}</p>
            <ScenarioComponent route={route} />
          </section>

          <aside className="panel capability-panel">
            <h2>Capability Matrix</h2>
            <CapabilityMatrix entries={reactCapabilityMatrix} />
          </aside>
        </div>
      </main>
  );
}

function CapabilityMatrix({ entries }: { entries: ExampleCapabilitySupport[] }) {
  return (
    <div className="matrix-wrapper">
      <table className="capability-table">
        <caption className="sr-only">React adapter capability support</caption>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.capability}>
              <th scope="row">{entry.capability}</th>
              <td>
                <span
                  className={
                    entry.status === "supported"
                      ? "status-chip supported"
                      : "status-chip unsupported"
                  }
                >
                  {entry.status}
                </span>
                {entry.note ? <small>{entry.note}</small> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsConsoleScenario({ route }: ScenarioComponentProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const [switchStates, setSwitchStates] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(settingsToggles.map((toggle) => [toggle.id, toggle.defaultEnabled])),
  );
  const [checkboxStates, setCheckboxStates] = useState<Record<string, boolean>>({
    general: true,
    notifications: false,
    security: true,
  });

  const applySettings = () => {
    setDialogOpen(false);
    setToastOpen(true);
  };

  return (
    <ToastProvider
      duration={3500}
      toasts={
        toastOpen
          ? [
              {
                id: "settings-saved",
                title: "Settings saved",
                description: "Your React example preferences were applied successfully.",
                duration: 3500,
              },
            ]
          : []
      }
      onDismiss={() => setToastOpen(false)}
    >
      <div className="scenario-stack" data-route={route}>
      <div className="scenario-toolbar">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger className="primary-button">Open settings console</DialogTrigger>
          <DialogPortal>
            <DialogBackdrop className="dialog-overlay" />
            <DialogContent className="dialog-content">
              <div className="dialog-header">
                <div>
                  <DialogTitle>Workspace settings</DialogTitle>
                  <DialogDescription>
                    Review defaults, notification rules, and approval prompts.
                  </DialogDescription>
                </div>
                <DialogClose className="ghost-button" aria-label="Close settings dialog">
                  Close
                </DialogClose>
              </div>

              <Tabs defaultValue={settingsSections[0].id}>
                <TabsList className="tabs-list">
                  {settingsSections.map((section) => (
                    <TabsTrigger
                      key={section.id}
                      value={section.id}
                      className="tab-trigger"
                    >
                      {section.title}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {settingsSections.map((section) => {
                  const toggle = settingsToggles.find(
                    (item) => item.sectionId === section.id,
                  );
                  const checkboxId = `checkbox-${section.id}`;

                  return (
                    <TabsContent key={section.id} value={section.id} className="tab-panel">
                      <p>{section.description}</p>

                      {toggle ? (
                        <label className="control-row">
                          <span>
                            <strong>{toggle.label}</strong>
                            <small>{toggle.description}</small>
                          </span>
                          <Switch
                            checked={switchStates[toggle.id]}
                            onCheckedChange={(checked) =>
                              setSwitchStates((current) => ({
                                ...current,
                                [toggle.id]: checked,
                              }))
                            }
                            aria-label={toggle.label}
                            className="switch-root"
                          >
                            <SwitchThumb className="switch-thumb" />
                          </Switch>
                        </label>
                      ) : null}

                      <label className="control-row checkbox-row" htmlFor={checkboxId}>
                        <span>
                          <strong>Require notes for changes</strong>
                          <small>Capture operator intent before applying updates.</small>
                        </span>
                        <Checkbox
                          id={checkboxId}
                          checked={checkboxStates[section.id]}
                          onCheckedChange={(checked) =>
                            setCheckboxStates((current) => ({
                              ...current,
                              [section.id]: checked === true,
                            }))
                          }
                          aria-label={`Require notes for ${section.title}`}
                          className="checkbox-root"
                        >
                          <CheckboxIndicator className="checkbox-indicator">
                            ✓
                          </CheckboxIndicator>
                        </Checkbox>
                      </label>
                    </TabsContent>
                  );
                })}
              </Tabs>

              <div className="dialog-actions">
                <button className="ghost-button" type="button" onClick={() => setDialogOpen(false)}>
                  Cancel
                </button>
                <button className="primary-button" type="button" onClick={applySettings}>
                  Apply settings
                </button>
              </div>
            </DialogContent>
          </DialogPortal>
        </Dialog>

        <p className="scenario-note">
          This flow exercises dialog, tabs, switch, checkbox, and toast primitives in
          one preferences interaction.
        </p>
      </div>

      {toastOpen ? (
        <ToastRoot value="settings-saved" className="toast-card">
          <ToastTitle value="settings-saved">Settings saved</ToastTitle>
          <ToastDescription value="settings-saved">
            Your React example preferences were applied successfully.
          </ToastDescription>
          <ToastClose
            value="settings-saved"
            className="ghost-button"
            aria-label="Dismiss notification"
          >
            Dismiss
          </ToastClose>
        </ToastRoot>
      ) : null}
      <ToastViewport />
    </div>
    </ToastProvider>
  );
}

function TeamDirectoryScenario({ route }: ScenarioComponentProps) {
  return (
    <div className="scenario-stack" data-route={route}>
      <p className="scenario-note">
        Team cards pair avatar fallbacks with menus, popovers, and hover-card details.
      </p>
      <div className="member-grid">
        {teamMembers.map((member) => (
          <article key={member.id} className="member-card">
            <div className="member-topline">
              <Avatar className="avatar-root">
                <AvatarFallback className="avatar-fallback">{member.initials}</AvatarFallback>
              </Avatar>
              <div>
                <HoverCard openDelay={100} closeDelay={100}>
                  <HoverCardTrigger href={`#profile-${member.id}`} className="member-link">
                    {member.name}
                  </HoverCardTrigger>
                  <HoverCardContent className="floating-card">
                    <strong>{member.role}</strong>
                    <p>{member.location}</p>
                  </HoverCardContent>
                </HoverCard>
                <p className="member-role">{member.role}</p>
              </div>
              <Badge variant="outline" className="status-badge">
                {member.status}
              </Badge>
            </div>

            <div className="member-actions">
              <Popover>
                <PopoverTrigger className="ghost-button">Details</PopoverTrigger>
                <PopoverContent className="floating-card">
                  <h3>{member.name}</h3>
                  <p>Location: {member.location}</p>
                  <p>Status: {member.status}</p>
                  <PopoverClose className="ghost-button">Done</PopoverClose>
                </PopoverContent>
              </Popover>

              <DropdownMenu items={memberActionItems}>
                <DropdownMenuTrigger className="ghost-button">
                  Actions
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel value={member.id}>Quick actions</DropdownMenuLabel>
                  <DropdownMenuItem value="message">Message teammate</DropdownMenuItem>
                  <DropdownMenuItem value="review">Assign reviewer</DropdownMenuItem>
                  <DropdownMenuSeparator value={`${member.id}-separator`} />
                  <DropdownMenuItem value="profile">Open profile</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function CommandCenterScenario({ route }: ScenarioComponentProps) {
  const [selectedCommand, setSelectedCommand] = useState(commandItems[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");

  const visibleCommands = useMemo(() => {
    return commandItems.filter((command) => {
      const matchesQuery = command.title.toLowerCase().includes(query.toLowerCase());
      const matchesGroup = groupFilter === "all" || command.group === groupFilter;
      return matchesQuery && matchesGroup;
    });
  }, [groupFilter, query]);

  const visibleResults = useMemo(() => {
    return resultRows.filter((row) =>
      row.label.toLowerCase().includes(query.toLowerCase()),
    );
  }, [query]);

  return (
    <div className="scenario-stack" data-route={route}>
      <div className="command-grid">
        <div className="command-controls">
          <label className="field-label">
            <span>Command palette</span>
            <Combobox
              value={selectedCommand}
              onValueChange={setSelectedCommand}
              inputValue={query}
              onInputValueChange={setQuery}
              defaultOpen
            >
              <ComboboxInput
                className="text-input"
                aria-label="Search commands"
                placeholder="Type to filter commands"
              />
              <ComboboxContent className="picker-surface">
                {visibleCommands.map((command) => (
                  <ComboboxItem key={command.id} value={command.id}>
                    {command.title}
                  </ComboboxItem>
                ))}
              </ComboboxContent>
            </Combobox>
          </label>

          <label className="field-label">
            <span>Command group</span>
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger className="text-input" aria-label="Filter command group">
                <SelectValue placeholder="Filter group" />
              </SelectTrigger>
              <SelectContent className="picker-surface">
                <SelectItem value="all">All groups</SelectItem>
                <SelectItem value="Navigation">Navigation</SelectItem>
                <SelectItem value="Creation">Creation</SelectItem>
                <SelectItem value="Maintenance">Maintenance</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <ContextMenu items={commandMenuItems}>
          <ContextMenuTrigger className="results-shell">
            <ScrollArea className="results-area">
              <ScrollAreaViewport className="results-viewport">
                <ul className="result-list">
                  {visibleResults.slice(0, 18).map((row) => (
                    <li key={row.id} className="result-row">
                      <span>{row.label}</span>
                      <small>{row.category}</small>
                    </li>
                  ))}
                </ul>
              </ScrollAreaViewport>
              <ScrollAreaScrollbar orientation="vertical" value="vertical" className="scrollbar">
                <ScrollAreaThumb value="vertical" className="scroll-thumb" />
              </ScrollAreaScrollbar>
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem value="run">Run selected command</ContextMenuItem>
            <ContextMenuItem value="copy">Copy route</ContextMenuItem>
            <ContextMenuItem value="pin">Pin to favorites</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </div>
  );
}

function VirtualizedResultsScenario({ route }: ScenarioComponentProps) {
  return (
    <div className="scenario-stack" data-route={route}>
      <div className="results-summary">
        <p className="section-label">Virtualized dataset</p>
        <h3>{resultRows.length} logical rows</h3>
        <p>
          This route uses <code>VirtualizedList</code> with fixed row height, capped
          viewport height, and the adapter default overscan behavior.
        </p>
      </div>

      <div className="virtualized-frame">
        <VirtualizedList
          aria-label="Virtualized results"
          className="virtualized-list"
          items={resultRows}
          itemHeight={52}
          height={320}
          renderItem={(row, index) => (
            <button type="button" className="virtualized-row" aria-label={row.label}>
              <span>{row.label}</span>
              <small>
                {row.category} · row {index + 1}
              </small>
            </button>
          )}
        />
      </div>
    </div>
  );
}
