const player    = document.getElementById("radioPlayer");
const button    = document.getElementById("playButton");
const indicator = document.getElementById("liveIndicator");
const liveText  = document.getElementById("liveText");

#const STREAM_URL = "https://006f-154-56-136-98.ngrok-free.app/stream";
const STREAM_URL = "https://stream.radioarkana.com/stream";


// Apuntar el source al stream de ngrok
player.src = STREAM_URL;

button.addEventListener("click", () => {
  if (!player.paused) {
    // Si está reproduciendo, pausar
    player.pause();
    player.src = "";
    button.textContent = "Escuchar en Directo";
    return;
  }

  // Reconectar con cache-bust para evitar respuesta cacheada de ngrok
  player.src = STREAM_URL + "?t=" + Date.now();
  liveText.textContent = "Conectando...";
  button.textContent = "Conectando...";
  button.disabled = true;

  player.play()
    .then(() => {
      indicator.classList.remove("live-off");
      indicator.classList.add("live-on");
      liveText.textContent = "EN DIRECTO";
      button.textContent = "Detener";
      button.disabled = false;
    })
    .catch(err => {
      console.log("Error al reproducir:", err);
      indicator.classList.remove("live-on");
      indicator.classList.add("live-off");
      liveText.textContent = "Error de conexión";
      button.textContent = "Reintentar";
      button.disabled = false;
    });
});

player.addEventListener("pause", () => {
  indicator.classList.remove("live-on");
  indicator.classList.add("live-off");
  liveText.textContent = "Desconectado";
  button.textContent = "Escuchar en Directo";
});

player.addEventListener("ended", () => {
  indicator.classList.remove("live-on");
  indicator.classList.add("live-off");
  liveText.textContent = "Desconectado";
  button.textContent = "Escuchar en Directo";
});

player.addEventListener("error", () => {
  indicator.classList.remove("live-on");
  indicator.classList.add("live-off");
  liveText.textContent = "Sin señal";
  button.textContent = "Reintentar";
  button.disabled = false;
  console.log("Stream no disponible. ¿Está Icecast y ngrok corriendo?");
});

player.addEventListener("waiting", () => {
  liveText.textContent = "Conectando...";
});

player.addEventListener("playing", () => {
  indicator.classList.remove("live-off");
  indicator.classList.add("live-on");
  liveText.textContent = "EN DIRECTO";
  button.textContent = "Detener";
  button.disabled = false;
});
