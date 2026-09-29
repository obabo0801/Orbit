import styles from "#web/core/screen.module.css";

export function screen(root) {
  const main = document.createElement("main");
  const title = document.createElement("h1");

  main.className = styles.screen;
  title.className = styles.title;
  title.textContent = "Orbit";

  main.append(title);

  root.replaceChildren(main);
}
