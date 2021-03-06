import sharp from 'sharp';
import libraw from 'libraw';
import fs from 'fs';
import exiv2 from 'exiv2';
import moment from 'moment';
import Promise from 'bluebird';

import config from './config';
import metadata from './metadata';

import walker from './lib/walker';
import matches from './lib/matches';

import Photo from './models/photo';
import Tag from './models/tag';

const readFile = Promise.promisify(fs.readFile);
const exGetImgTags = Promise.promisify(exiv2.getImageTags);

const allowed = new RegExp(config.acceptedRawFormats.join('$|') + '$', 'i');
const allowedImg = new RegExp(config.acceptedImgFormats.join('$|') + '$', 'i');

const extract = new RegExp(
  '([^\/]+)\.(' + config.acceptedRawFormats.join('|') + ')$',
  'i'
);

const extractImg = new RegExp(
  '([^\/]+)\.(' + config.acceptedImgFormats.join('|') + ')$',
  'i'
);

export default class Scanner {
  constructor(path, versionsPath, mainWindow) {
    this.path = path;
    this.versionsPath = versionsPath;
    this.mainWindow = mainWindow;

    this.progress = {
      processed: 0,
      total: 0,
      photosDir: path
    };

    this.scanPictures = this.scanPictures.bind(this);
    this.prepare = this.prepare.bind(this);
    this.setTotal = this.setTotal.bind(this);
    this.filterStoredPhoto = this.filterStoredPhoto.bind(this);
    this.importRaw = this.importRaw.bind(this);
    this.importImg = this.importImg.bind(this);
    this.populateTags = this.populateTags.bind(this);
  }

  prepare(filePaths) {
    let rawFiles = filePaths.map(filePath =>
      filePath.match(allowed) ? filePath : null
    )
    .filter(filePath => filePath);

    let imgFiles = filePaths.map(filePath =>
      filePath.match(allowedImg) ? filePath : null
    )
    .filter(filePath => filePath);

    let preparedFiles = rawFiles.map(rawFile => {
      let filename = rawFile.match(extract)[1];
      let imgPos = matches(imgFiles, filename);

      let element = {
        path: rawFile,
        name: filename,
        isRaw: true
      };

      if (imgPos !== -1) {
        element.imgPath = imgFiles[imgPos];

        imgFiles = imgFiles.filter(imgFile =>
          imgFile !== imgFiles[imgPos]
        );
      }

      return element;
    });

    imgFiles.forEach(imgFile => {
      let filename = imgFile.match(extractImg)[1];

      preparedFiles.push({
        path: imgFile,
        name: filename,
        isRaw: false
      });
    });

    return preparedFiles;
  }

  walk(file) {
    if (file.isRaw)
      return this.importRaw(file);

    return this.importImg(file);
  }

  importRaw(file) {
    let waitFor;

    if (file.hasOwnProperty('imgPath'))
      waitFor = Promise.resolve(file.imgPath);
    else {
      waitFor = libraw.extractThumb(
        `${file.path}`,
        `${config.tmp}/${file.name}`
      );
    }

    return waitFor
      .then(imgPath => readFile(imgPath))
      .then(img => sharp(img)
        .rotate()
        .withMetadata()
        .toFile(`${config.thumbsPath}/${file.name}.thumb.${config.workExt}`)
      )
      .then(() =>
        sharp(`${config.thumbsPath}/${file.name}.thumb.${config.workExt}`)
          .resize(250, 250)
          .max()
          .quality(100)
          .toFile(`${config.thumbs250Path}/${file.name}.${config.workExt}`)
      )
      .then(() => exGetImgTags(file.path).then(metadata.processData))
      .then(xmp => {
        let createdAt = moment(xmp.createdAt, 'YYYY:MM:DD HH:mm:ss');

        return new Photo({ title: file.name })
          .fetch()
          .then(photo => {
            if (photo)
              return null;

            return Photo.forge({
              title: file.name,
              extension: file.path.match(/\.(.+)$/i)[1],
              orientation: xmp.orientation,
              date: createdAt.format('YYYY-MM-DD'),
              created_at: createdAt.toDate(),
              exposure_time: xmp.exposureTime,
              iso: xmp.iso,
              aperture: xmp.fNumber,
              focal_length: xmp.focalLength,
              master: `${file.path}`,
              thumb_250: `${config.thumbs250Path}/${file.name}.${config.workExt}`,
              thumb: `${config.thumbsPath}/${file.name}.thumb.${config.workExt}`
            })
            .save();
          })
          .then(photo => this.populateTags(photo, xmp.tags));
      })
      .then(this.onImportedStep.bind(this))
      .catch(err => {
        console.error('ERR knex', file, err);
      });
  }

  importImg(file) {
    return Promise.join(
      sharp(file.path)
        .resize(250, 250)
        .max()
        .quality(100)
        .toFile(`${config.thumbs250Path}/${file.name}.${config.workExt}`),
      exGetImgTags(file.path).then(metadata.processData),
      (img, xmp) => {
        let createdAt;

        if (xmp.hasOwnProperty('createdAt'))
          createdAt = moment(xmp.createdAt, 'YYYY:MM:DD HH:mm:ss');
        else {
          let fileDate = fs.statSync(file.path);

          createdAt = moment(fileDate.birthtime);
        }

        return new Photo({ title: file.name })
          .fetch()
          .then(photo =>
            photo ? null : Photo.forge({
              title: file.name,
              extension: file.path.match(/\.(.+)$/i)[1],
              orientation: xmp.orientation,
              date: createdAt.format('YYYY-MM-DD'),
              created_at: createdAt.toDate(),
              exposure_time: xmp.exposureTime,
              iso: xmp.iso,
              aperture: xmp.fNumber,
              focal_length: xmp.focalLength,
              master: file.path,
              thumb_250: `${config.thumbs250Path}/${file.name}.${config.workExt}`,
              thumb: file.path
            })
            .save()
          )
          .then(photo => this.populateTags(photo, xmp.tags));
      }
    )
    .then(this.onImportedStep.bind(this))
    .catch(err => {
      console.error('err', err);
      return false;
    });
  }

  populateTags(photo, tags) {
    if (tags.length > 0) {
      return Promise.each(tags, tagName =>
        new Tag({ title: tagName })
          .fetch()
          .then(tag =>
            tag ? tag : new Tag({ title: tagName }).save()
          )
          .then(tag => tag.photos().attach(photo))
      )
      .then(() => photo);
    }

    return photo;
  }
  onImportedStep() {
    this.progress.processed++;
    this.mainWindow.webContents.send('progress', this.progress);
    return true;
  }

  filterStoredPhoto(file) {
    return new Photo({ master: file.path })
      .fetch()
      .then(photo => !photo);
  }

  setTotal(files) {
    this.progress.total = files.length;
    return files;
  }

  scanPictures() {
    return walker(this.path, [ this.versionsPath ])
      .then(this.prepare)
      .filter(this.filterStoredPhoto)
      .then(this.setTotal)
      .map(this.walk.bind(this), {
        concurrency: config.concurrency
      });
  }
}
