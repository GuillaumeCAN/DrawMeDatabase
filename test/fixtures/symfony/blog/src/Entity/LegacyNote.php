<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * Written for doctrine/annotations (ORM 2), before PHP 8 attributes.
 *
 * @ORM\Entity(repositoryClass="App\Repository\LegacyNoteRepository")
 * @ORM\Table(name="legacy_note")
 */
class LegacyNote
{
    /**
     * @ORM\Id
     * @ORM\GeneratedValue
     * @ORM\Column(type="integer")
     */
    private $id;

    /**
     * @ORM\Column(type="text", name="note_text", nullable=true)
     */
    private $text;

    /**
     * @ORM\ManyToOne(targetEntity="App\Entity\Post")
     * @ORM\JoinColumn(name="post_ref", nullable=false)
     */
    private $post;

    /**
     * @ORM\ManyToMany(targetEntity="Tag")
     * @ORM\JoinTable(name="legacy_note_tags")
     */
    private $tags;
}
