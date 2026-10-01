// jsdom does not implement native dialog methods. Browser focus containment
// is verified separately; these methods model visibility for component tests.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
