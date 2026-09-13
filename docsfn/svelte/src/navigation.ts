interface NavigationPage {
  path: string;
}

export function navigateTo(path: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.location.href = path;
}

export function handlePaginationShortcut(input: {
  event: KeyboardEvent;
  prevPage?: NavigationPage;
  nextPage?: NavigationPage;
  navigate?: (path: string) => void;
}): boolean {
  const navigate = input.navigate ?? navigateTo;

  if (input.event.altKey && input.event.key === "ArrowLeft" && input.prevPage) {
    navigate(input.prevPage.path);
    return true;
  }

  if (input.event.altKey && input.event.key === "ArrowRight" && input.nextPage) {
    navigate(input.nextPage.path);
    return true;
  }

  return false;
}
