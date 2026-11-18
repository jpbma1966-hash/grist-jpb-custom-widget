import { md2docx } from "@m2d/md2docx";

const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const convertButton = document.getElementById("convertButton");
const resetButton = document.getElementById("resetButton");
const status = document.getElementById("status");
const dropzone = document.getElementById("dropzone");

let selectedFile = null;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 Mo

function showStatus(message, type = "") {
  status.textContent = message;
  status.className = type;
}

function setFile(file) {
  if (!file) return;

  const validName = /\.(md|markdown)$/i.test(file.name);
  if (!validName) {
    selectedFile = null;
    fileName.textContent = "Aucun fichier sélectionné";
    convertButton.disabled = true;
    showStatus("Veuillez sélectionner un fichier .md ou .markdown.", "error");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    selectedFile = null;
    fileName.textContent = "Aucun fichier sélectionné";
    convertButton.disabled = true;
    showStatus("Le fichier dépasse la taille maximale autorisée de 10 Mo.", "error");
    return;
  }

  selectedFile = file;
  fileName.textContent = `${file.name} (${formatSize(file.size)})`;
  convertButton.disabled = false;
  showStatus("Fichier prêt à être converti.");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} octets`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function safeDocxName(name) {
  return name.replace(/\.(md|markdown)$/i, "").replace(/[\\/:*?"<>|]/g, "_") + ".docx";
}

fileInput.addEventListener("change", () => {
  setFile(fileInput.files?.[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    setFile(file);
    // Conserver le fichier dans l'input n'est pas nécessaire pour la conversion.
  }
});

convertButton.addEventListener("click", async () => {
  if (!selectedFile) return;

  convertButton.disabled = true;
  showStatus("Lecture du Markdown…");

  try {
    const markdown = await selectedFile.text();

    if (!markdown.trim()) {
      throw new Error("Le fichier est vide.");
    }

    showStatus("Conversion du document et rendu des diagrammes Mermaid…");

    const title = selectedFile.name.replace(/\.(md|markdown)$/i, "");
    const docxBlob = await md2docx(markdown, {
      title,
      creator: "Grist - Convertisseur Markdown"
    });

    if (!(docxBlob instanceof Blob) || docxBlob.size === 0) {
      throw new Error("Le moteur de conversion n'a pas produit de document Word.");
    }

    const url = URL.createObjectURL(docxBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeDocxName(selectedFile.name);
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Laisser au navigateur le temps de démarrer le téléchargement.
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    showStatus("Conversion terminée : le téléchargement du fichier Word a été lancé.", "success");
  } catch (error) {
    console.error("Erreur de conversion Markdown vers DOCX :", error);
    showStatus(
      `Échec de la conversion : ${error?.message || "erreur inconnue"}. Vérifiez notamment la syntaxe des diagrammes Mermaid.`,
      "error"
    );
  } finally {
    convertButton.disabled = !selectedFile;
  }
});

resetButton.addEventListener("click", () => {
  selectedFile = null;
  fileInput.value = "";
  fileName.textContent = "Aucun fichier sélectionné";
  convertButton.disabled = true;
  showStatus("");
});

// Intégration facultative : le widget reste autonome et n'utilise aucune table Grist.
if (window.grist && typeof window.grist.ready === "function") {
  window.grist.ready();
}
