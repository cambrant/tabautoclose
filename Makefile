.PHONY: build clean

build: autotabclose.xpi

autotabclose.xpi: manifest.json background.js options.html options.js icon.png
	zip -r $@ $^

clean:
	rm -f autotabclose.xpi
